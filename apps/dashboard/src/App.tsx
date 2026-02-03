import { useEffect, useMemo, useState } from "react";

type FetchConfig = {
  baseUrl: string;
  apiKey: string;
};

type ToolResult = {
  status: "success" | "error";
  summary: string;
  data?: unknown;
  error?: string;
  timestamp: string;
};

type TaskField = {
  name: string;
  label: string;
  type: "text" | "date" | "number";
  placeholder?: string;
  helper?: string;
  required?: boolean;
};

type TravelTarget = {
  vendor: string;
  type: "flight" | "hotel";
  title: string;
  url: string;
  jsonOptions?: Record<string, unknown>;
  forceEngine?: string;
};

type TaskDefinition = {
  id: string;
  label: string;
  description: string;
  type: "flight" | "hotel";
  fields: TaskField[];
  buildTargets: (values: Record<string, string>) => TravelTarget[];
  forceEngine?: string;
};

const DEFAULT_BASE_URL = "http://localhost:8080";

const usePersistedState = (key: string, initial: string) => {
  const [value, setValue] = useState(() => window.localStorage.getItem(key) ?? initial);
  useEffect(() => {
    window.localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue] as const;
};

const requestWithRetry = async <T,>(
  path: string,
  body: Record<string, unknown>,
  config: FetchConfig,
  method: "POST" | "GET" = "POST"
): Promise<T> => {
  const url = new URL(path, config.baseUrl).toString();
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: method === "POST" ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      const payload = text ? (JSON.parse(text) as T) : (undefined as T);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unknown request error");
};

const generateDateRange = (start?: string, end?: string) => {
  if (!start) return [];
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return [];
  let endDate = end ? new Date(end) : startDate;
  if (Number.isNaN(endDate.getTime()) || endDate < startDate) endDate = startDate;
  const days: string[] = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
};

const buildGoogleFlightsUrl = (origin: string, destination: string, depart?: string, returnDate?: string) => {
  if (!origin || !destination) return "https://www.google.com/travel/flights";
  const segment = (from: string, to: string, date?: string) => `${from}.${to}.${date ?? ""}`;
  let hash = `#flt=${segment(origin, destination, depart)}`;
  if (returnDate) hash += `*${segment(destination, origin, returnDate)}`;
  return `https://www.google.com/travel/flights?hl=en${hash}`;
};

const buildExpediaHotelUrl = (city: string, checkIn: string, nights: number) => {
  if (!city || !checkIn) return "https://www.expedia.com/Hotel-Search";
  const start = new Date(checkIn);
  const out = new Date(start);
  out.setDate(start.getDate() + Math.max(nights, 1));
  const params = new URLSearchParams({
    destination: city,
    startDate: start.toISOString().slice(0, 10),
    endDate: out.toISOString().slice(0, 10),
    adults: "2",
  });
  return `https://www.expedia.com/Hotel-Search?${params.toString()}`;
};

const detectPrice = (text?: string) => {
  if (!text) return {} as { price?: number; priceText?: string };
  const match = text.match(/\$\s?[0-9,.]+/);
  if (!match) return {} as { price?: number; priceText?: string };
  const priceText = match[0];
  const numeric = Number(priceText.replace(/[^0-9.]/g, ""));
  return Number.isFinite(numeric) ? { price: numeric, priceText } : { priceText };
};

const summarizeSnippet = (markdown?: string) =>
  markdown
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(" • ");

const getArrayFromMaybe = (value: any): any[] | null => {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.options)) return value.options;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return null;
};

type AggregatedOption = {
  vendor: string;
  type: "flight" | "hotel";
  sourceUrl: string;
  price?: number;
  priceText?: string;
  currency?: string;
  carrier?: string;
  summary?: string;
  metadata?: any;
};

const normalizeStructuredOptions = (
  structured: any,
  target: TravelTarget,
  fallbackMarkdown?: string
): AggregatedOption[] => {
  const array = getArrayFromMaybe(structured);
  if (!array || !array.length) {
    const priceInfo = detectPrice(fallbackMarkdown);
    return [
      {
        vendor: target.vendor,
        type: target.type,
        sourceUrl: target.url,
        price: priceInfo.price,
        priceText: priceInfo.priceText,
        summary: summarizeSnippet(fallbackMarkdown),
        metadata: structured ?? null,
      },
    ];
  }
  return array.map((item: any) => ({
    vendor: target.vendor,
    type: target.type,
    sourceUrl: target.url,
    price: item.price_value ?? item.price ?? item.priceValue ?? item.amount,
    priceText: item.price_text ?? item.priceText ?? item.price_label ?? item.price_display,
    currency: item.currency ?? item.currency_code ?? "USD",
    carrier: item.airline ?? item.carrier ?? item.hotel_name ?? item.name,
    summary: item.summary ?? item.description ?? summarizeSnippet(fallbackMarkdown),
    metadata: item,
  }));
};

const FLIGHT_OPTION_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      airline: { type: "string" },
      flight_number: { type: "string" },
      depart_time: { type: "string" },
      arrive_time: { type: "string" },
      duration: { type: "string" },
      price_text: { type: "string" },
      price_value: { type: "number" },
      currency: { type: "string" },
      booking_url: { type: "string" },
      summary: { type: "string" },
    },
    required: ["price_text"],
  },
};

const HOTEL_OPTION_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      hotel_name: { type: "string" },
      neighborhood: { type: "string" },
      rating: { type: "string" },
      amenities: { type: "array", items: { type: "string" } },
      price_text: { type: "string" },
      price_value: { type: "number" },
      currency: { type: "string" },
      booking_url: { type: "string" },
      summary: { type: "string" },
    },
    required: ["price_text"],
  },
};

const GOOGLE_FLIGHTS_TASK: TaskDefinition = {
  id: "google-flights",
  label: "Google Flights (price scan)",
  description: "Enumerates Google Flights URLs over a date window, then scrapes fares for comparison.",
  type: "flight",
  fields: [
    { name: "origin", label: "Origin airport/city", type: "text", placeholder: "SFO", required: true },
    { name: "destination", label: "Destination", type: "text", placeholder: "JFK", required: true },
    { name: "departStart", label: "Depart start", type: "date", required: true },
    { name: "departEnd", label: "Depart end", type: "date", helper: "Optional window end" },
    { name: "returnStart", label: "Return start", type: "date" },
    { name: "returnEnd", label: "Return end", type: "date", helper: "Optional window end" },
  ],
  buildTargets: (values) => {
    const departRange = generateDateRange(values.departStart, values.departEnd);
    const returnRange = generateDateRange(values.returnStart || values.returnStart || values.departStart, values.returnEnd);
    const departures = departRange.length ? departRange : [values.departStart];
    const returns = values.returnStart ? (returnRange.length ? returnRange : [values.returnStart]) : [undefined];
    const targets: TravelTarget[] = [];
    departures.filter(Boolean).forEach((depart) => {
      returns.forEach((ret) => {
        targets.push({
          vendor: "Google Flights",
          type: "flight",
          title: `${values.origin} → ${values.destination} ${depart}${ret ? ` / ${ret}` : ""}`,
          url: buildGoogleFlightsUrl(values.origin, values.destination, depart, ret),
          forceEngine: "playwright",
          jsonOptions: {
            schema: {
              type: "object",
              properties: {
                options: FLIGHT_OPTION_SCHEMA,
                notes: { type: "string" },
              },
              required: ["options"],
            },
            user_prompt: `Extract up to 3 flight itineraries for ${values.origin} to ${values.destination} departing ${
              depart ?? "unknown"
            }${ret ? ` and returning ${ret}` : ""}. For each option, include airline, flight_number if present, depart_time, arrive_time, duration, price_text, price_value (number only), currency, booking_url, and a short summary.`,
            schema_name: "FlightOptions",
            schema_description: "Structured list of flight options with price and timing information.",
          },
        });
      });
    });
    return targets;
  },
  forceEngine: "playwright",
};

const EXPEDIA_HOTELS_TASK: TaskDefinition = {
  id: "expedia-hotels",
  label: "Expedia Hotels",
  description: "Build Expedia hotel search URLs over a stay window, then scrape rates.",
  type: "hotel",
  fields: [
    { name: "city", label: "City or area", type: "text", placeholder: "New York", required: true },
    { name: "checkInStart", label: "Check-in start", type: "date", required: true },
    { name: "checkInEnd", label: "Check-in end", type: "date", helper: "Optional window" },
    { name: "nights", label: "Nights", type: "number", placeholder: "3" },
  ],
  buildTargets: (values) => {
    const nights = Number(values.nights) || 2;
    const range = generateDateRange(values.checkInStart, values.checkInEnd);
    const checkIns = range.length ? range : [values.checkInStart];
    return checkIns.filter(Boolean).map((checkIn) => ({
      vendor: "Expedia",
      type: "hotel",
      title: `${values.city} stay starting ${checkIn}`,
      url: buildExpediaHotelUrl(values.city, checkIn, nights),
      forceEngine: "playwright",
      jsonOptions: {
        schema: {
          type: "object",
          properties: {
            options: HOTEL_OPTION_SCHEMA,
            notes: { type: "string" },
          },
          required: ["options"],
        },
        user_prompt: `Extract up to 3 hotel options for ${values.city} checking in ${checkIn} for ${nights} nights. Provide hotel_name, neighborhood, rating (if available), amenities list, price_text, price_value (number), currency, booking_url, and a short summary.`,
        schema_name: "HotelOptions",
        schema_description: "Structured list of hotel options with nightly price information.",
      },
    }));
  },
  forceEngine: "playwright",
};

const TASKS: TaskDefinition[] = [GOOGLE_FLIGHTS_TASK, EXPEDIA_HOTELS_TASK];

const SCRAPE_ENGINES = [
  { label: "Cheerio (fast)", value: "cheerio" },
  { label: "Playwright (JS heavy)", value: "playwright" },
];

const LLM_PROVIDERS = [
  { label: "Disabled", value: "none" },
  { label: "OpenAI-compatible", value: "openai" },
  { label: "Google Gemini", value: "gemini" },
];

const STEP_LIST = [
  { id: 1, label: "Connect Keys" },
  { id: 2, label: "Pick Intent" },
  { id: 3, label: "Run & Summarize" },
];

export default function App() {
  const [baseUrl, setBaseUrl] = usePersistedState("anycrawl-base-url", DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = usePersistedState("anycrawl-api-key", "");
  const config = useMemo(() => ({ baseUrl, apiKey }), [baseUrl, apiKey]);

  const [llmProvider, setLlmProvider] = usePersistedState("anycrawl-llm-provider", "none");
  const [openAiKey, setOpenAiKey] = usePersistedState("anycrawl-openai-key", "");
  const [openAiModel, setOpenAiModel] = usePersistedState("anycrawl-openai-model", "gpt-4o-mini");
  const [openAiBase, setOpenAiBase] = usePersistedState("anycrawl-openai-base", "https://api.openai.com/v1");
  const [geminiKey, setGeminiKey] = usePersistedState("anycrawl-gemini-key", "");
  const [geminiModel, setGeminiModel] = usePersistedState("anycrawl-gemini-model", "gemini-pro");
  const [llmPrompt, setLlmPrompt] = useState(
    "Summarize these travel options for a traveler. Highlight the cheapest flight and best-value hotel."
  );

  const [taskId, setTaskId] = useState(TASKS[0].id);
  const selectedTask = useMemo(() => TASKS.find((task) => task.id === taskId)!, [taskId]);
  const [taskInputs, setTaskInputs] = useState<Record<string, string>>({});
  useEffect(() => {
    const defaults: Record<string, string> = {};
    selectedTask.fields.forEach((field) => {
      defaults[field.name] = "";
    });
    setTaskInputs(defaults);
  }, [selectedTask]);

  const [scrapeEngine, setScrapeEngine] = useState("cheerio");
  const [rawResult, setRawResult] = useState<ToolResult | null>(null);
  const [llmResult, setLlmResult] = useState<ToolResult | null>(null);
  const [loading, setLoading] = useState(false);
  const connectionReady = Boolean(baseUrl && apiKey);
  const hasResults = Boolean(rawResult);
  const activeStep = !connectionReady ? 1 : hasResults ? 3 : 2;

  const updateInput = (name: string, value: string) => {
    setTaskInputs((prev) => ({ ...prev, [name]: value }));
  };

  const ensureConnection = () => {
    if (!config.apiKey) throw new Error("Please provide your AnyCrawl API key.");
    if (!config.baseUrl) throw new Error("Please provide the AnyCrawl base URL.");
  };

  const runTask = async () => {
    try {
      ensureConnection();
      setLoading(true);
      setRawResult(null);
      setLlmResult(null);
      selectedTask.fields.forEach((field) => {
        if (field.required && !taskInputs[field.name]) {
          throw new Error(`Missing required field: ${field.label}`);
        }
      });
      const targets = selectedTask.buildTargets(taskInputs);
      if (!targets.length) throw new Error("No crawl targets were generated. Please adjust your date range.");
      const aggregatedOptions: AggregatedOption[] = [];
      const scrapePayloads = await Promise.all(
        targets.map(async (target) => {
          try {
            const engineToUse = target.forceEngine ?? selectedTask.forceEngine ?? scrapeEngine;
            const body: Record<string, unknown> = {
              url: target.url,
              engine: engineToUse,
              extract_source: "markdown",
              formats: ["markdown", "json"],
            };
            if (target.jsonOptions) body.json_options = target.jsonOptions;
            const response = await requestWithRetry<any>("/v1/scrape", body, config);
            const data = response?.data ?? response;
            const markdown =
              typeof data === "object" && typeof data?.markdown === "string"
                ? data.markdown
                : JSON.stringify(data, null, 2);
            const structured = data?.json ?? data?.structured ?? null;
            const normalized = normalizeStructuredOptions(structured, target, markdown);
            aggregatedOptions.push(...normalized);
            return {
              success: true,
              target,
              engine: engineToUse,
              title: data?.title ?? target.title,
              markdown,
              snippet: summarizeSnippet(markdown),
              structured,
              raw: data,
            };
          } catch (error) {
            return {
              success: false,
              target,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        })
      );
      const aggregated = {
        task: selectedTask.id,
        inputs: taskInputs,
        engine: selectedTask.forceEngine ?? scrapeEngine,
        options: aggregatedOptions,
        targets: scrapePayloads,
      };
      const summaryTitle = `${selectedTask.label} • ${new Date().toLocaleString()}`;
      setRawResult({
        status: "success",
        summary: summaryTitle,
        data: aggregated,
        timestamp: new Date().toISOString(),
      });
      if (llmProvider !== "none") {
        const llmText = await runLlmSummarizer(llmProvider, { openAiKey, openAiModel, openAiBase, geminiKey, geminiModel, prompt: llmPrompt }, aggregated);
        setLlmResult({
          status: "success",
          summary: "LLM summary",
          data: { output: llmText, provider: llmProvider },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRawResult({
        status: "error",
        summary: "Task failed",
        error: message,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="brand-pill">AnyCrawl Studio</p>
          <h1>Travel-ready intelligence in three elegant steps.</h1>
          <p>
            Connect your crawler, declare what you need (flights or hotels), and receive structured comparisons plus an
            LLM-friendly briefing you can forward to teams or clients.
          </p>
        </div>
        <div className="hero-panel">
          <StepIndicator steps={STEP_LIST} active={activeStep} />
        </div>
      </header>

      <section className="panel">
        <h2>1. AnyCrawl Connection</h2>
        <div className="grid two">
          <label>
            Base URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:8080" />
          </label>
          <label>
            API Key
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="ac-..." />
          </label>
        </div>
        <label>
          Scrape engine
          <select value={scrapeEngine} onChange={(e) => setScrapeEngine(e.target.value)}>
            {SCRAPE_ENGINES.map((engine) => (
              <option key={engine.value} value={engine.value}>
                {engine.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="panel">
        <h2>2. LLM Summarizer (optional)</h2>
        <div className="grid two">
          <label>
            Provider
            <select value={llmProvider} onChange={(e) => setLlmProvider(e.target.value)}>
              {LLM_PROVIDERS.map((provider) => (
                <option key={provider.value} value={provider.value}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea rows={3} value={llmPrompt} onChange={(e) => setLlmPrompt(e.target.value)} />
          </label>
        </div>
        {llmProvider === "openai" && (
          <div className="grid three">
            <label>
              OpenAI key
              <input value={openAiKey} onChange={(e) => setOpenAiKey(e.target.value)} placeholder="sk-..." />
            </label>
            <label>
              Model
              <input value={openAiModel} onChange={(e) => setOpenAiModel(e.target.value)} />
            </label>
            <label>
              Base URL
              <input value={openAiBase} onChange={(e) => setOpenAiBase(e.target.value)} />
            </label>
          </div>
        )}
        {llmProvider === "gemini" && (
          <div className="grid two">
            <label>
              Gemini API key
              <input value={geminiKey} onChange={(e) => setGeminiKey(e.target.value)} placeholder="AIza..." />
            </label>
            <label>
              Model
              <input value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)} />
            </label>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>3. Intent-driven crawl</h2>
            <p className="helper-text">Pick a template card, fill the fields, and AnyCrawl will do the rest.</p>
          </div>
        </div>
        <TaskSwitcher tasks={TASKS} activeId={taskId} onSelect={setTaskId} />
        <p className="intent-description">{selectedTask.description}</p>
        <div className="grid two form-grid">
          {selectedTask.fields.map((field) => (
            <label key={field.name}>
              {field.label}
              {field.type === "text" && (
                <input
                  type="text"
                  value={taskInputs[field.name] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) => updateInput(field.name, e.target.value)}
                />
              )}
              {field.type === "date" && (
                <input
                  type="date"
                  value={taskInputs[field.name] ?? ""}
                  onChange={(e) => updateInput(field.name, e.target.value)}
                />
              )}
              {field.type === "number" && (
                <input
                  type="number"
                  value={taskInputs[field.name] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) => updateInput(field.name, e.target.value)}
                />
              )}
              {field.helper && <small className="helper-text">{field.helper}</small>}
            </label>
          ))}
        </div>
        <div className="cta-row">
          <div className="cta-copy">
            <strong>Targets generated automatically</strong>
            <p className="helper-text">Playwright engine is enforced for these intents to capture live pricing.</p>
          </div>
          <button className="primary large" disabled={loading} onClick={runTask}>
            {loading ? "Running..." : `Run ${selectedTask.label}`}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>4. Raw crawl output</h2>
            <p>Copy this JSON into downstream systems or inspect it before the LLM step.</p>
          </div>
        </div>
        <ResultCard result={rawResult} />
      </section>

      {llmProvider !== "none" && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>5. LLM summary</h2>
              <p>Friendly recap from {llmProvider === "openai" ? "OpenAI" : "Gemini"}.</p>
            </div>
          </div>
          <ResultCard result={llmResult} />
        </section>
      )}

      <footer>
        <p>TIP: For larger workloads, wire these actions into agents via AnyCrawl's REST API and your preferred LLM stack.</p>
      </footer>
    </div>
  );
}

const ResultCard = ({ result }: { result: ToolResult | null }) => {
  if (!result) return <div className="result-card">No data yet.</div>;
  return (
    <div className={`result-card ${result.status}`}>
      <div className="result-meta">
        <span>{result.status === "success" ? "✅" : "⚠️"}</span>
        <strong>{result.summary}</strong>
        <span className="timestamp">{new Date(result.timestamp).toLocaleString()}</span>
      </div>
      {result.error && <p className="error-text">{result.error}</p>}
      <pre className="json-view">{JSON.stringify(result.data ?? result.error, null, 2)}</pre>
    </div>
  );
};

const StepIndicator = ({ steps, active }: { steps: { id: number; label: string }[]; active: number }) => (
  <ol className="stepper">
    {steps.map((step) => (
      <li key={step.id} className={`step ${active === step.id ? "active" : active > step.id ? "done" : ""}`}>
        <span className="step-index">{step.id}</span>
        <span className="step-label">{step.label}</span>
      </li>
    ))}
  </ol>
);

const TaskSwitcher = ({
  tasks,
  activeId,
  onSelect,
}: {
  tasks: TaskDefinition[];
  activeId: string;
  onSelect: (id: string) => void;
}) => (
  <div className="task-switcher">
    {tasks.map((task) => {
      const active = task.id === activeId;
      return (
        <button key={task.id} className={`task-card ${active ? "active" : ""}`} onClick={() => onSelect(task.id)}>
          <div className="task-card-header">
            <span className={`task-pill ${task.type}`}>{task.type === "flight" ? "Flights" : "Hotels"}</span>
            {active && <span className="task-active-dot">Selected</span>}
          </div>
          <h3>{task.label}</h3>
          <p>{task.description}</p>
        </button>
      );
    })}
  </div>
);

const runLlmSummarizer = async (
  provider: string,
  options: {
    openAiKey: string;
    openAiModel: string;
    openAiBase: string;
    geminiKey: string;
    geminiModel: string;
    prompt: string;
  },
  payload: unknown
): Promise<string> => {
  if (provider === "openai") {
    if (!options.openAiKey) throw new Error("OpenAI key missing");
    const endpoint = `${options.openAiBase.replace(/\/$/, "")}/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.openAiKey}`,
      },
      body: JSON.stringify({
        model: options.openAiModel,
        messages: [
          { role: "system", content: "You are a concise travel assistant." },
          { role: "user", content: `${options.prompt}\n\nData:\n${JSON.stringify(payload, null, 2)}` },
        ],
      }),
    });
    const completion = await response.json();
    if (!response.ok) throw new Error(completion?.error?.message ?? response.statusText);
    return completion?.choices?.[0]?.message?.content ?? "(LLM returned no content)";
  }
  if (provider === "gemini") {
    if (!options.geminiKey) throw new Error("Gemini key missing");
    const url = new URL(
      `https://generativelanguage.googleapis.com/v1beta/models/${options.geminiModel}:generateContent`
    );
    url.searchParams.set("key", options.geminiKey);
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: options.prompt },
              { text: `Data:\n${JSON.stringify(payload, null, 2)}` },
            ],
          },
        ],
      }),
    });
    const completion = await response.json();
    if (!response.ok) throw new Error(completion?.error?.message ?? response.statusText);
    return completion?.candidates?.[0]?.content?.parts?.map((part: any) => part.text).join("\n") ?? "(No content)";
  }
  return "LLM provider disabled.";
};
