const ATPROTO_STATUS_URI =
  "at://did:plc:krxbvxvis5skq7jj6eot23ul/fm.teal.alpha.actor.status/self";
const SLACK_TOKENS = [
  process.env.SLACK_TOKEN,
  process.env.SLACK_TOKEN_2,
].filter(Boolean) as string[];
const POLL_INTERVAL = 30_000; // 30s
const PORT = parseInt(process.env.PORT || "3000", 10);

// --- AT Protocol helpers ---

async function resolveDidToPds(did: string): Promise<string | null> {
  if (did.startsWith("did:plc:")) {
    const res = await fetch(`https://plc.directory/${did}`);
    const doc = await res.json();
    return doc.service?.find((s: any) => s.id === "#atproto_pds")
      ?.serviceEndpoint;
  } else if (did.startsWith("did:web:")) {
    const domain = did.slice(8);
    const res = await fetch(`https://${domain}/.well-known/did.json`);
    const doc = await res.json();
    return doc.service?.find((s: any) => s.id === "#atproto_pds")
      ?.serviceEndpoint;
  }
  return null;
}

async function fetchAtUriRecord(atUri: string): Promise<any | null> {
  const match = atUri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, repo, collection, rkey] = match;
  const pds = await resolveDidToPds(repo);
  if (!pds) return null;
  const url = `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repo)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

// --- State ---

type PfpState = "default" | "headphones" | "zz";

let currentState: PfpState = "default";
const lastSlackUpdate = new Map<string, string>();

// --- Music detection ---

async function checkNowPlaying(): Promise<boolean> {
  try {
    const data = await fetchAtUriRecord(ATPROTO_STATUS_URI);
    if (!data?.value?.item) return false;
    const expiry = new Date(data.value.expiry).getTime();
    return Date.now() <= expiry + 5 * 60_000;
  } catch {
    return false;
  }
}

// --- Image selection ---

function getHour(): number {
  return new Date().getHours();
}

function getImagePath(hour: number, state: PfpState): string {
  const h = hour.toString().padStart(2, "0");
  const suffix = state === "default" ? "" : `_${state}`;
  return `./imgs/${h}${suffix}.png`;
}

function determineState(isPlaying: boolean): PfpState {
  if (isPlaying) return "headphones";
  const hour = getHour();
  if (hour >= 0 && hour < 7) return "zz";
  return "default";
}

// --- Slack ---

async function updateSlackPfp(token: string, label: string, imagePath: string) {
  if (lastSlackUpdate.get(token) === imagePath) return;

  const file = Bun.file(imagePath);
  const blob = await file.arrayBuffer();

  const form = new FormData();
  form.append("image", new Blob([blob], { type: "image/png" }), "pfp.png");

  const res = await fetch("https://slack.com/api/users.setPhoto", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const data = await res.json();
  if (data.ok) {
    lastSlackUpdate.set(token, imagePath);
    console.log(`[slack:${label}] updated pfp to ${imagePath}`);
  } else {
    console.error(`[slack:${label}] failed to update pfp:`, data.error);
  }
}

// --- Poll loop ---

async function tick() {
  const isPlaying = await checkNowPlaying();
  const state = determineState(isPlaying);
  const hour = getHour();
  const imagePath = getImagePath(hour, state);

  currentState = state;

  await Promise.all(
    SLACK_TOKENS.map((token, i) =>
      updateSlackPfp(token, i === 0 ? "primary" : `workspace-${i + 1}`, imagePath)
    )
  );
}

tick();
setInterval(tick, POLL_INTERVAL);

// --- Server ---

Bun.serve({
  port: PORT,
  routes: {
    "/pfp": async () => {
      const hour = getHour();
      const imagePath = getImagePath(hour, currentState);
      const file = Bun.file(imagePath);
      return new Response(file, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      });
    },
    "/status": () => {
      return Response.json({
        state: currentState,
        hour: getHour(),
        image: getImagePath(getHour(), currentState),
      });
    },
  },
  fetch() {
    return new Response("Not found", { status: 404 });
  },
});

console.log(`livepfp running on http://localhost:${PORT}`);
console.log(`  GET /pfp    → current profile picture`);
console.log(`  GET /status → current state as JSON`);
