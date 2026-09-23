// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// Runs INSIDE the browser page via page.evaluate(): must be fully self-contained
// (no imports, no references to module scope). Fetches a site URL with the page's
// session and parses the HTML with the browser's own DOMParser.

export type ParseKind = "modComments" | "modThreadId" | "forumPage" | "forumTopic";

export interface ParseArgs {
  kind: ParseKind;
  url: string;
}

export async function fetchAndParse({ kind, url }: ParseArgs): Promise<any> {
  // www.nexusmods.com answers these page/widget fetches only as XHR (as its own jQuery
  // front-end sends them); without the header it returns 403.
  const xhr = new URL(url).hostname === "www.nexusmods.com";
  const r = await fetch(url, { credentials: "include", headers: xhr ? { "X-Requested-With": "XMLHttpRequest" } : {} });
  const html = await r.text();
  if (!r.ok) return { error: `HTTP ${r.status}: ${html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}` };

  if (kind === "modThreadId") {
    // Mod page Posts tab: data-target="/Core/Libs/Common/Widgets/CommentContainer?...&thread_id=NNN..."
    const m = html.match(/CommentContainer\?[^"']*?thread_id=(\d+)/);
    return { threadId: m ? Number(m[1]) : null };
  }

  const doc = new DOMParser().parseFromString(html, "text/html");

  // Text with line breaks for <br> and block elements; blank lines collapsed.
  const textOf = (el: Element | null | undefined): string => {
    if (!el) return "";
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
    clone.querySelectorAll("p,div,li,blockquote,pre,h1,h2,h3,h4,h5,tr").forEach((b) => b.append("\n"));
    clone.querySelectorAll("script,style").forEach((s) => s.remove());
    return (clone.textContent || "")
      .replace(/[ \t ]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };
  const txt = (el: Element | null | undefined) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const maxPage = (sel: string): number => {
    let max = 1;
    doc.querySelectorAll(sel).forEach((a) => {
      const n = parseInt((a.textContent || "").trim(), 10);
      if (n > max) max = n;
    });
    return max;
  };

  if (kind === "modComments") {
    const pick = (li: Element): any => ({
      id: li.id.replace("comment-", ""),
      author: txt(li.querySelector(":scope > .comment-head .comment-name a")) || "?",
      date: Number(li.querySelector(":scope > .comment-content time[data-date]")?.getAttribute("data-date")) || 0,
      sticky: li.classList.contains("comment-sticky"),
      locked: !!li.querySelector(":scope > .comment-content .locked:not([style*='none'])"),
      text: textOf(li.querySelector(":scope > .comment-content .comment-content-text")),
      replies: Array.from(li.querySelectorAll(":scope > ol.comment-kids > li.comment")).map((k) => ({
        id: k.id.replace("comment-", ""),
        author: txt(k.querySelector(":scope > .comment-head .comment-name a")) || "?",
        date: Number(k.querySelector(":scope > .comment-content time[data-date]")?.getAttribute("data-date")) || 0,
        text: textOf(k.querySelector(":scope > .comment-content .comment-content-text")),
      })),
    });
    const top = Array.from(doc.querySelectorAll("li.comment")).filter((li) => !li.parentElement?.classList.contains("comment-kids"));
    return {
      total: Number(doc.querySelector("#comment-count")?.getAttribute("data-comment-count")) || 0,
      page: Number((doc.querySelector("#current-page-number") as HTMLInputElement | null)?.value) || 1,
      pages: maxPage(".pagination li a"),
      csrfToken: doc.querySelector("[data-csrf-token]")?.getAttribute("data-csrf-token") || null,
      comments: top.map(pick),
    };
  }

  if (kind === "forumPage") {
    const forums = Array.from(doc.querySelectorAll("li.cForumRow[data-forumid]")).map((li) => {
      const a = li.querySelector(".ipsDataItem_title a");
      return {
        id: li.getAttribute("data-forumid"),
        title: txt(a),
        url: a?.getAttribute("href") || "",
        description: txt(li.querySelector(".ipsDataItem_meta")).slice(0, 200),
        posts: txt(li.querySelector(".ipsDataItem_stats_number")),
      };
    });
    const topics = Array.from(doc.querySelectorAll("li.ipsDataItem[data-rowid]")).map((li) => {
      const a = li.querySelector(".ipsDataItem_title a");
      return {
        id: li.getAttribute("data-rowid"),
        title: txt(a),
        url: a?.getAttribute("href") || "",
        author: txt(li.querySelector(".ipsDataItem_meta a.ipsType_break")),
        date: li.querySelector(".ipsDataItem_meta time")?.getAttribute("datetime") || "",
        replies: txt(li.querySelector("[data-stattype='forums_comments'] .ipsDataItem_stats_number")),
        views: txt(li.querySelector("[data-stattype='num_views'] .ipsDataItem_stats_number")),
      };
    });
    return {
      title: txt(doc.querySelector("h1.ipsType_pageTitle")) || doc.title,
      pages: Number(doc.querySelector("[data-pages]")?.getAttribute("data-pages")) || 1,
      forums,
      topics,
    };
  }

  if (kind === "forumTopic") {
    const posts = Array.from(doc.querySelectorAll("article.cPost")).map((art) => ({
      id: art.id.replace("elComment_", ""),
      author: txt(art.querySelector("aside .cAuthorPane_author a")) || txt(art.querySelector(".cAuthorPane_author a")) || "?",
      date: art.querySelector("time[datetime]")?.getAttribute("datetime") || "",
      text: textOf(art.querySelector("[data-role='commentContent']")),
    }));
    return {
      title: txt(doc.querySelector("h1.ipsType_pageTitle")) || doc.title,
      pages: Number(doc.querySelector("[data-pages]")?.getAttribute("data-pages")) || 1,
      posts,
    };
  }

  return { error: `unknown parse kind ${kind}` };
}
