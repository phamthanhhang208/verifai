import type { JiraTicket, Bug, BugSeverity } from "@verifai/types";

const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || "").replace(/\/+$/, "");
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

  /**
   * Recursively extract plain text from Jira's Atlassian Document Format (ADF).
   * ADF is a tree of nodes like:
   *   { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }] }
   * We walk the tree depth-first and reconstruct readable text.
   */
  function extractADFText(node: any): string {
    if (!node) return "";
    if (typeof node === "string") return node;

    // Leaf text node — return its text directly
    if (node.type === "text") return node.text || "";

    // Recurse into children
    if (node.content && Array.isArray(node.content)) {
      const childTexts = node.content.map(extractADFText);

      switch (node.type) {
        case "paragraph":
        case "heading":
          return childTexts.join("") + "\n";
        case "bulletList":
        case "orderedList":
          return childTexts.join("");
        case "listItem":
          return "• " + childTexts.join("").trim() + "\n";
        case "doc":
          return childTexts.join("\n");
        default:
          return childTexts.join(" ");
      }
    }

    // Fallback for nodes with just a text property (shouldn't happen in ADF v1)
    if (node.text) return node.text;

    return "";
  }

  const summary = fields.summary || "";
  const description = extractADFText(fields.description).trim();
  const acceptanceCriteria = extractADFText(
    fields.customfield_10001 || fields.customfield_10200 || fields.customfield_10300
  ).trim();

  console.log(`[Jira] Ticket ${data.key}:`);
  console.log(`[Jira]   Summary: ${summary}`);
  console.log(`[Jira]   Description (${description.length} chars): ${description.slice(0, 200)}`);
  console.log(`[Jira]   Acceptance Criteria (${acceptanceCriteria.length} chars): ${acceptanceCriteria.slice(0, 200)}`);

  return {
    key: data.key,
    summary,
    description,
    acceptanceCriteria,
    url: `${JIRA_BASE_URL}/browse/${data.key}`,
  };
}

function severityToPriority(severity: BugSeverity): { id: string } {
  switch (severity) {
    case "high": return { id: "2" };
    case "medium": return { id: "3" };
    case "low": return { id: "4" };
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
