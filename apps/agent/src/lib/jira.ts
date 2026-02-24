import type { JiraTicket, Bug, BugSeverity } from "@verifai/types";

const JIRA_BASE_URL = process.env.JIRA_BASE_URL!;
const JIRA_EMAIL = process.env.JIRA_EMAIL!;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN!;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY!;

function authHeader(): string {
  return `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;
}

export async function fetchTicket(ticketId: string): Promise<JiraTicket> {
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}`, {
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
    },
  });

  if (!res.ok) throw new Error(`Jira fetch failed: ${res.status}`);

  const data = await res.json();
  const fields = data.fields;

  function extractADFText(node: any): string {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (node.text) return node.text;
    if (node.content && Array.isArray(node.content)) {
      return node.content.map(extractADFText).join(" ");
    }
    return "";
  }

  return {
    key: data.key,
    summary: fields.summary || "",
    description: extractADFText(fields.description),
    acceptanceCriteria: extractADFText(
      fields.customfield_10001 || fields.customfield_10200 || fields.customfield_10300
    ),
    url: `${JIRA_BASE_URL}/browse/${data.key}`,
  };
}

function severityToPriority(severity: BugSeverity): { id: string } {
  switch (severity) {
    case "high":   return { id: "2" };
    case "medium": return { id: "3" };
    case "low":    return { id: "4" };
  }
}

export async function createBugTicket(
  bug: Bug,
  sourceTicket: string
): Promise<{ key: string; url: string }> {
  // Guard: don't create tickets if Jira not configured
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_PROJECT_KEY) {
    throw new Error("Jira credentials not configured");
  }

  const descriptionParts: any[] = [
    {
      type: "paragraph",
      content: [{ type: "text", text: bug.description }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: `\nExpected: ${bug.expectedBehavior}` }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: `Actual: ${bug.actualBehavior}` }],
    },
  ];

  if (bug.failureType) {
    descriptionParts.push({
      type: "paragraph",
      content: [{ type: "text", text: `\nFailure Type: ${bug.failureType}` }],
    });
  }

  if (bug.screenshotUrl) {
    descriptionParts.push({
      type: "paragraph",
      content: [{ type: "text", text: `\nScreenshot: ${bug.screenshotUrl}` }],
    });
  }

  const body = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary: bug.title,
      description: {
        type: "doc",
        version: 1,
        content: descriptionParts,
      },
      issuetype: { name: "Bug" },
      priority: severityToPriority(bug.severity),
      labels: [
        "verifai-auto",
        `source-${sourceTicket}`,
        `failure-${bug.failureType || "assertion"}`,
      ],
    },
  };

  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Jira create failed: ${res.status} — ${errBody}`);
  }

  const data = await res.json();
  return {
    key: data.key,
    url: `${JIRA_BASE_URL}/browse/${data.key}`,
  };
}
