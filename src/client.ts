/**
 * Thin HTTP client for the Payghaam MCP surface.
 *
 * Deliberately just `fetch` — this package is run through `npx` on a
 * developer's machine, so every dependency is startup latency they pay for and
 * a supply-chain surface they didn't ask for.
 */

export interface ClientOptions {
  apiKey?: string;
  accessToken?: string;
  baseUrl: string;
}

export interface EventReadiness {
  name: string;
  status: "OBSERVED" | "DECLARED" | "EXPECTED";
  count: number;
  lastSeenAt: string | null;
  /**
   * Keys a journey filters on that have never arrived on this event.
   *
   * The second way to be un-instrumented, and the quieter one: status is
   * OBSERVED because the event itself shows up, but a filter reading a key
   * that never does declines every one of them, so users park at a step that
   * looks healthy. Optional because an older API will not send it.
   */
  missingProperties?: string[];
}

/** One property key the app already sends, and the type it arrives as. */
export interface EventProperty {
  eventName: string;
  key: string;
  type: "STRING" | "NUMBER" | "BOOLEAN" | "DATE";
  lastSeenAt: string | null;
}

export interface ExpectedEvent extends EventReadiness {
  neededBy: { journeyId: string; journeyName: string }[];
}

export interface JourneySummary {
  id: string;
  name: string;
  status: string;
  events: string[];
}

/**
 * Journey-level settings, passed through as-is.
 *
 * Typed `unknown` rather than modeled field-by-field: the shape mirrors
 * whatever `packages/shared/journey-dsl.ts` accepts on a plan's `entry`,
 * `entryAudience`, `exitOn`, `reentry` and `schedule`, and duplicating that
 * here would drift the moment either side changes. This client passes it
 * straight through to the tool layer, which is where it becomes readable text.
 */
export interface JourneySettings {
  entryTrigger?: unknown;
  entryAudience?: unknown;
  reentry?: unknown;
  exitRule?: unknown;
  schedule?: unknown;
}

export interface JourneyDescription extends JourneySettings {
  id: string;
  name: string;
  status: string;
  steps: { id: string; kind: string; label: string; detail: string }[];
  events: EventReadiness[];
  ready: number;
  total: number;
}

export interface DraftedJourney extends JourneySettings {
  id: string;
  name: string;
  status: string;
  warnings: string[];
  events: EventReadiness[];
  steps: { id: string; kind: string; label: string; detail: string }[];
}

export interface ProjectContext {
  project: string;
  journeys: number;
  expectedEventCount: number;
  summary: string;
}

export interface GeneratedConstants {
  path: string | null;
  content: string | null;
  events: string[];
  note?: string;
}

export type Platform = "FLUTTER" | "ANDROID" | "IOS" | "REACT_NATIVE" | "WEB";

export class PayghaamApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PayghaamApiError";
  }
}

export class PayghaamClient {
  private readonly apiKey?: string;
  private readonly accessToken?: string;
  private readonly baseUrl: string;

  constructor(options: ClientOptions) {
    if (!options.apiKey && !options.accessToken) {
      throw new Error("PayghaamClient requires either an apiKey or an accessToken.");
    }
    this.apiKey = options.apiKey;
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  context(): Promise<ProjectContext> {
    return this.request<ProjectContext>("GET", "/mcp/context");
  }

  expectedEvents(): Promise<ExpectedEvent[]> {
    return this.request<ExpectedEvent[]>("GET", "/mcp/events/expected");
  }

  journeys(): Promise<JourneySummary[]> {
    return this.request<JourneySummary[]>("GET", "/mcp/journeys");
  }

  journey(journeyId: string): Promise<JourneyDescription> {
    return this.request<JourneyDescription>(
      "GET",
      `/mcp/journeys/${encodeURIComponent(journeyId)}`,
    );
  }

  constants(body: {
    platform: Platform;
    packageName?: string;
    events?: string[];
  }): Promise<GeneratedConstants> {
    return this.request<GeneratedConstants>("POST", "/mcp/events/constants", body);
  }

  properties(eventName?: string): Promise<EventProperty[]> {
    const query = eventName ? `?eventName=${encodeURIComponent(eventName)}` : "";
    return this.request<EventProperty[]>("GET", `/mcp/events/properties${query}`);
  }

  declare(events: string[]): Promise<EventReadiness[]> {
    return this.request<EventReadiness[]>("POST", "/mcp/events/declared", { events });
  }

  createDraft(plan: unknown): Promise<DraftedJourney> {
    return this.request<DraftedJourney>("POST", "/mcp/journeys", { plan });
  }

  /**
   * Recompile a plan onto an existing journey. The server refuses (409) unless
   * the journey is still DRAFT — an activated journey has run for real people,
   * and is not reachable from this method at all.
   */
  updateDraft(journeyId: string, plan: unknown): Promise<DraftedJourney> {
    return this.request<DraftedJourney>(
      "PATCH",
      `/mcp/journeys/${encodeURIComponent(journeyId)}`,
      { plan },
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    } else if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new PayghaamApiError(
        0,
        `Could not reach ${this.baseUrl}. Check PAYGHAAM_API_URL and your network. (${String(err)})`,
      );
    }

    if (!res.ok) {
      throw new PayghaamApiError(res.status, await describeFailure(res));
    }
    return (await res.json()) as T;
  }
}

/**
 * Turn a failed response into something the *agent* can act on, since it is the
 * one reading this. A 401 here almost always means the key is missing or is the
 * wrong type, and saying so is far more useful than "Unauthorized".
 */
async function describeFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { message?: string | string[]; errors?: string[] };
    if (parsed.message) {
      detail = Array.isArray(parsed.message) ? parsed.message.join("; ") : parsed.message;
    }
    // Plan validation returns a list of specific problems ("steps[1].nudges[0].at:
    // expected a duration like 2d"). They are the whole value of the response —
    // the model that wrote the plan reads them back and fixes it — so they must
    // survive rather than collapse into "Bad Request".
    if (parsed.errors?.length) {
      detail = [detail, ...parsed.errors.map((e) => `  - ${e}`)].join("\n");
    }
  } catch {
    // Not JSON; the raw body is the best we have.
  }

  if (res.status === 401) {
    return "Authentication failed (token or key rejected). Run `npx @payghaam/mcp-server login` or create an MCP key in the Payghaam dashboard under Project settings → Code.";
  }
  if (res.status === 403) {
    return `${detail}\n\nRead tools need a key starting "ek_mcp_"; drafting journeys needs an author key starting "ek_mcpa_". Both are created in the Payghaam dashboard under Project settings → Code. Ask the developer to swap the key — you cannot widen it yourself.`;
  }
  return detail || `Request failed with status ${res.status}`;
}
