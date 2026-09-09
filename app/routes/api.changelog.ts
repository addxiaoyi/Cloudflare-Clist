import type { Route } from "./+types/api.changelog";

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  author: {
    login: string;
    avatar_url: string;
  };
}

interface ReleaseItem {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  isPrerelease: boolean;
  author: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const GITHUB_API_URL = "https://api.github.com/repos/ooyyh/Cloudflare-Clist/releases";

  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "Mozilla/5.0 (compatible)",
      },
    });

    if (!response.ok) {
      return Response.json(
        { error: "Failed to fetch releases from GitHub" },
        { status: response.status }
      );
    }

    const releases: GitHubRelease[] = await response.json();

    // Filter out drafts and map to our format
    const releaseItems: ReleaseItem[] = releases
      .filter(r => !r.draft)
      .map(r => ({
        version: r.tag_name,
        name: r.name || r.tag_name,
        body: r.body || "",
        publishedAt: r.published_at,
        url: r.html_url,
        isPrerelease: r.prerelease,
        author: r.author?.login || "unknown",
      }));

    return Response.json({ releases: releaseItems });
  } catch (error) {
    console.error("Error fetching GitHub releases:", error);
    return Response.json(
      { error: "Failed to fetch releases" },
      { status: 500 }
    );
  }
}
