import { NextRequest, NextResponse } from "next/server";

const CONFLUENCE_BASE_URL = process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL;
const CONFLUENCE_EMAIL = process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL;
const CONFLUENCE_API_TOKEN = process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN;

function authHeader(): string {
    return `Basic ${Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString("base64")}`;
}

/**
 * Extract page ID from various Confluence URL formats:
 * - https://domain.atlassian.net/wiki/spaces/SPACE/pages/123456/Page+Title
 * - Just the page ID: "123456"
 */
function extractPageId(input: string): string {
    // Already a numeric ID
    if (/^\d+$/.test(input.trim())) return input.trim();

    // URL with /pages/ID/
    const pagesMatch = input.match(/\/pages\/(\d+)/);
    if (pagesMatch) return pagesMatch[1];

    throw new Error(
        "Could not extract page ID from URL. Please use the format: https://domain.atlassian.net/wiki/spaces/SPACE/pages/PAGE_ID/Title or just the numeric page ID."
    );
}

/**
 * Strip HTML/Confluence storage format to plain text.
 * Preserves structure (headings, lists, tables) as readable text.
 */
function htmlToText(html: string): string {
    let text = html;

    // Convert headings to markdown-style
    text = text.replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n## $1\n");

    // Convert list items
    text = text.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");

    // Convert table cells
    text = text.replace(/<th[^>]*>(.*?)<\/th>/gi, "| $1 ");
    text = text.replace(/<td[^>]*>(.*?)<\/td>/gi, "| $1 ");
    text = text.replace(/<\/tr>/gi, "|\n");

    // Convert line breaks and paragraphs
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/p>/gi, "\n\n");
    text = text.replace(/<\/div>/gi, "\n");

    // Convert links — preserve text and URL
    text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)");

    // Convert bold/italic
    text = text.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
    text = text.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");

    // Convert code blocks
    text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");

    // Confluence macros — extract status content
    text = text.replace(
        /<ac:structured-macro[^>]*ac:name="status"[^>]*>[\s\S]*?<ac:parameter ac:name="title">([\s\S]*?)<\/ac:parameter>[\s\S]*?<\/ac:structured-macro>/gi,
        "[$1]"
    );

    // Strip remaining HTML tags
    text = text.replace(/<[^>]+>/g, "");

    // Decode HTML entities
    text = text.replace(/&amp;/g, "&");
    text = text.replace(/&lt;/g, "<");
    text = text.replace(/&gt;/g, ">");
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&nbsp;/g, " ");

    // Clean up whitespace
    text = text.replace(/\n{3,}/g, "\n\n");
    text = text.trim();

    return text;
}

async function fetchPage(pageId: string): Promise<{
    id: string;
    title: string;
    spaceKey: string;
    body: string;
    url: string;
    lastUpdated: string;
}> {
    if (!CONFLUENCE_BASE_URL || !CONFLUENCE_EMAIL || !CONFLUENCE_API_TOKEN) {
        throw new Error(
            "Confluence credentials not configured. Set CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN in .env (or use JIRA_* equivalents)."
        );
    }

    // Try v2 first, fall back to v1
    let res = await fetch(
        `${CONFLUENCE_BASE_URL}/wiki/api/v2/pages/${pageId}?body-format=storage`,
        {
            headers: {
                Authorization: authHeader(),
                Accept: "application/json",
            },
        }
    );

    if (!res.ok && res.status === 404) {
        // Fallback to v1 API
        res = await fetch(
            `${CONFLUENCE_BASE_URL}/wiki/rest/api/content/${pageId}?expand=body.storage,space,version`,
            {
                headers: {
                    Authorization: authHeader(),
                    Accept: "application/json",
                },
            }
        );
    }

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Confluence API error (${res.status}): ${errText.slice(0, 200)}`);
    }

    const data = await res.json();

    // Handle both v1 and v2 response shapes
    const bodyHtml =
        data.body?.storage?.value || // v1 + v2
        data.body?.value ||          // v2 alt
        "";

    const spaceKey = data.space?.key || data.spaceId || "";
    const title = data.title || "";
    const lastUpdated = data.version?.when || data.version?.createdAt || "";
    const pageUrl = data._links?.webui
        ? `${CONFLUENCE_BASE_URL}/wiki${data._links.webui}`
        : `${CONFLUENCE_BASE_URL}/wiki/spaces/${spaceKey}/pages/${pageId}`;

    return {
        id: pageId,
        title,
        spaceKey,
        body: htmlToText(bodyHtml),
        url: pageUrl,
        lastUpdated,
    };
}

async function fetchChildPages(
    pageId: string
): Promise<Array<{ id: string; title: string; body: string }>> {
    if (!CONFLUENCE_BASE_URL) return [];

    try {
        const res = await fetch(
            `${CONFLUENCE_BASE_URL}/wiki/rest/api/content/${pageId}/child/page?expand=body.storage&limit=10`,
            {
                headers: {
                    Authorization: authHeader(),
                    Accept: "application/json",
                },
            }
        );

        if (!res.ok) return [];

        const data = await res.json();
        return (data.results || []).map((child: any) => ({
            id: child.id,
            title: child.title,
            body: htmlToText(child.body?.storage?.value || ""),
        }));
    } catch {
        return [];
    }
}

export async function POST(req: NextRequest) {
    try {
        const { pageUrl, pageId: rawPageId, includeChildPages } = await req.json();

        // Extract page ID from URL or use directly
        const pageId = rawPageId || extractPageId(pageUrl || "");

        if (!pageId) {
            return NextResponse.json(
                { error: "Page ID or URL is required" },
                { status: 400 }
            );
        }

        // Fetch main page
        const page = await fetchPage(pageId);

        // Optionally fetch child pages
        let childPages: Array<{ id: string; title: string; body: string }> = [];
        if (includeChildPages) {
            childPages = await fetchChildPages(pageId);
        }

        // Combine all content for the response
        let combinedContent = `# ${page.title}\n\n${page.body}`;

        if (childPages.length > 0) {
            combinedContent += "\n\n---\n\n";
            for (const child of childPages) {
                combinedContent += `# ${child.title}\n\n${child.body}\n\n---\n\n`;
            }
        }

        return NextResponse.json({
            page: {
                id: page.id,
                title: page.title,
                spaceKey: page.spaceKey,
                url: page.url,
                lastUpdated: page.lastUpdated,
            },
            childPageCount: childPages.length,
            content: combinedContent,
            contentLength: combinedContent.length,
            truncated: combinedContent.length > 30000,
        });
    } catch (error: any) {
        console.error("[Confluence] Fetch error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
