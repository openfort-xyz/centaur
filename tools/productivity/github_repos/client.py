from __future__ import annotations

from typing import Any

import httpx

from centaur_sdk import secret

_GITHUB_API_BASE = "https://api.github.com"


class GitHubReposClient:
    """GitHub REST API client for repository operations.

    API reference: https://docs.github.com/en/rest
    Auth: ``GITHUB_TOKEN`` (personal access token or GitHub App installation token).

    Supports: repos, issues, pull requests, code search, git data, releases,
    and content retrieval.
    """

    def __init__(self, token: str | None = None):
        self.token = token or secret("GITHUB_TOKEN", "")
        if not self.token:
            raise RuntimeError(
                "GITHUB_TOKEN not set. Set it in your .env file "
                "or inject it via the Centaur secrets system."
            )
        self._http = httpx.Client(
            base_url=_GITHUB_API_BASE,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=30.0,
        )

    # ── Repositories ──────────────────────────────────────────────────────

    def get_repo(self, owner: str, repo: str) -> dict[str, Any]:
        """Get repository details.

        API: ``GET /repos/{owner}/{repo}``
        """
        r = self._http.get(f"/repos/{owner}/{repo}")
        r.raise_for_status()
        return r.json()

    def list_repos(
        self,
        owner: str,
        *,
        sort: str = "updated",
        per_page: int = 30,
    ) -> dict[str, Any]:
        """List repositories for an owner (user or org).

        API: ``GET /orgs/{owner}/repos`` or ``GET /users/{owner}/repos``
        """
        r = self._http.get(
            f"/orgs/{owner}/repos",
            params={"sort": sort, "per_page": min(per_page, 100)},
        )
        r.raise_for_status()
        return {"body": r.json(), "pagination": self._pagination(r)}

    def search_repos(
        self,
        query: str,
        *,
        per_page: int = 30,
    ) -> dict[str, Any]:
        """Search repositories by query.

        API: ``GET /search/repositories?q={query}``
        """
        r = self._http.get(
            "/search/repositories",
            params={"q": query, "per_page": min(per_page, 100)},
        )
        r.raise_for_status()
        return r.json()

    # ── Issues ────────────────────────────────────────────────────────────

    def list_issues(
        self,
        owner: str,
        repo: str,
        *,
        state: str = "open",
        labels: str | None = None,
        assignee: str | None = None,
        sort: str = "created",
        per_page: int = 30,
    ) -> dict[str, Any]:
        """List issues for a repository.

        API: ``GET /repos/{owner}/{repo}/issues``
        """
        params: dict[str, Any] = {
            "state": state, "sort": sort, "per_page": min(per_page, 100)
        }
        if labels: params["labels"] = labels
        if assignee: params["assignee"] = assignee

        r = self._http.get(f"/repos/{owner}/{repo}/issues", params=params)
        r.raise_for_status()
        return {"body": r.json(), "pagination": self._pagination(r)}

    def get_issue(self, owner: str, repo: str, issue_number: int) -> dict[str, Any]:
        """Get a single issue.

        API: ``GET /repos/{owner}/{repo}/issues/{issue_number}``
        """
        r = self._http.get(f"/repos/{owner}/{repo}/issues/{issue_number}")
        r.raise_for_status()
        return r.json()

    def create_issue(
        self,
        owner: str,
        repo: str,
        title: str,
        *,
        body: str | None = None,
        labels: list[str] | None = None,
        assignees: list[str] | None = None,
    ) -> dict[str, Any]:
        """Create a new issue.

        API: ``POST /repos/{owner}/{repo}/issues``
        """
        payload: dict[str, Any] = {"title": title}
        if body: payload["body"] = body
        if labels: payload["labels"] = labels
        if assignees: payload["assignees"] = assignees

        r = self._http.post(f"/repos/{owner}/{repo}/issues", json=payload)
        r.raise_for_status()
        return r.json()

    def update_issue(
        self, owner: str, repo: str, issue_number: int, **fields
    ) -> dict[str, Any]:
        """Update an issue. Fields: title, body, state, labels, assignees."""
        r = self._http.patch(
            f"/repos/{owner}/{repo}/issues/{issue_number}", json=fields
        )
        r.raise_for_status()
        return r.json()

    def create_issue_comment(
        self, owner: str, repo: str, issue_number: int, body: str
    ) -> dict[str, Any]:
        """Comment on an issue.

        API: ``POST /repos/{owner}/{repo}/issues/{issue_number}/comments``
        """
        r = self._http.post(
            f"/repos/{owner}/{repo}/issues/{issue_number}/comments",
            json={"body": body},
        )
        r.raise_for_status()
        return r.json()

    def list_issue_comments(
        self, owner: str, repo: str, issue_number: int
    ) -> dict[str, Any]:
        """List comments on an issue.

        API: ``GET /repos/{owner}/{repo}/issues/{issue_number}/comments``
        """
        r = self._http.get(f"/repos/{owner}/{repo}/issues/{issue_number}/comments")
        r.raise_for_status()
        return {"body": r.json(), "pagination": self._pagination(r)}

    # ── Pull Requests ─────────────────────────────────────────────────────

    def list_pull_requests(
        self,
        owner: str,
        repo: str,
        *,
        state: str = "open",
        sort: str = "created",
        per_page: int = 30,
    ) -> dict[str, Any]:
        """List pull requests for a repository.

        API: ``GET /repos/{owner}/{repo}/pulls``
        """
        r = self._http.get(
            f"/repos/{owner}/{repo}/pulls",
            params={"state": state, "sort": sort, "per_page": min(per_page, 100)},
        )
        r.raise_for_status()
        return {"body": r.json(), "pagination": self._pagination(r)}

    def get_pull_request(
        self, owner: str, repo: str, pull_number: int
    ) -> dict[str, Any]:
        """Get a single pull request.

        API: ``GET /repos/{owner}/{repo}/pulls/{pull_number}``
        """
        r = self._http.get(f"/repos/{owner}/{repo}/pulls/{pull_number}")
        r.raise_for_status()
        return r.json()

    def create_pull_request(
        self,
        owner: str,
        repo: str,
        title: str,
        head: str,
        base: str,
        *,
        body: str | None = None,
        draft: bool = False,
    ) -> dict[str, Any]:
        """Create a new pull request.

        API: ``POST /repos/{owner}/{repo}/pulls``
        """
        payload: dict[str, Any] = {
            "title": title, "head": head, "base": base
        }
        if body: payload["body"] = body
        if draft: payload["draft"] = True

        r = self._http.post(f"/repos/{owner}/{repo}/pulls", json=payload)
        r.raise_for_status()
        return r.json()

    def get_pr_files(
        self, owner: str, repo: str, pull_number: int
    ) -> dict[str, Any]:
        """List files changed in a pull request.

        API: ``GET /repos/{owner}/{repo}/pulls/{pull_number}/files``
        """
        r = self._http.get(f"/repos/{owner}/{repo}/pulls/{pull_number}/files")
        r.raise_for_status()
        return {"body": r.json(), "pagination": self._pagination(r)}

    def get_pr_reviews(
        self, owner: str, repo: str, pull_number: int
    ) -> dict[str, Any]:
        """List reviews on a pull request.

        API: ``GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews``
        """
        r = self._http.get(f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews")
        r.raise_for_status()
        return {"body": r.json(), "pagination": self._pagination(r)}

    def create_pr_review(
        self,
        owner: str,
        repo: str,
        pull_number: int,
        body: str,
        event: str = "COMMENT",
    ) -> dict[str, Any]:
        """Create a review on a pull request.

        API: ``POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews``

        Args:
            event: ``"APPROVE"``, ``"REQUEST_CHANGES"``, or ``"COMMENT"``.
        """
        r = self._http.post(
            f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
            json={"body": body, "event": event},
        )
        r.raise_for_status()
        return r.json()

    # ── Code Search ───────────────────────────────────────────────────────

    def search_code(
        self,
        query: str,
        *,
        per_page: int = 30,
    ) -> dict[str, Any]:
        """Search code across repositories.

        API: ``GET /search/code?q={query}``
        """
        r = self._http.get(
            "/search/code",
            params={"q": query, "per_page": min(per_page, 100)},
        )
        r.raise_for_status()
        return r.json()

    # ── Contents ──────────────────────────────────────────────────────────

    def get_contents(
        self,
        owner: str,
        repo: str,
        path: str,
        *,
        ref: str | None = None,
    ) -> dict[str, Any]:
        """Get file or directory contents from a repository.

        API: ``GET /repos/{owner}/{repo}/contents/{path}``

        For files < 1MB, the content is base64-encoded in ``content``.
        For directories, returns a list of entries.
        """
        params = {}
        if ref:
            params["ref"] = ref
        r = self._http.get(
            f"/repos/{owner}/{repo}/contents/{path}", params=params
        )
        r.raise_for_status()
        return r.json()

    def get_file_content(
        self,
        owner: str,
        repo: str,
        path: str,
        *,
        ref: str | None = None,
    ) -> dict[str, Any]:
        """Get file content with decoded text.

        Returns ``{"path": ..., "text": ..., "sha": ..., "encoding": "base64"}``.
        """
        import base64
        result = self.get_contents(owner, repo, path, ref=ref)
        if isinstance(result, list):
            return {"path": path, "type": "directory", "entries": result}
        content = result.get("content", "")
        if content:
            result["text"] = base64.b64decode(content).decode("utf-8", errors="replace")
        return result

    # ── Git References & Commits ──────────────────────────────────────────

    def get_ref(
        self, owner: str, repo: str, ref: str = "heads/main"
    ) -> dict[str, Any]:
        """Get a Git reference.

        API: ``GET /repos/{owner}/{repo}/git/ref/{ref}``
        """
        r = self._http.get(f"/repos/{owner}/{repo}/git/ref/{ref}")
        r.raise_for_status()
        return r.json()

    def get_commit(
        self, owner: str, repo: str, sha: str
    ) -> dict[str, Any]:
        """Get a commit by SHA.

        API: ``GET /repos/{owner}/{repo}/git/commits/{sha}``
        """
        r = self._http.get(f"/repos/{owner}/{repo}/git/commits/{sha}")
        r.raise_for_status()
        return r.json()

    def list_commits(
        self,
        owner: str,
        repo: str,
        *,
        sha: str | None = None,
        per_page: int = 30,
    ) -> dict[str, Any]:
        """List commits on a repository or branch.

        API: ``GET /repos/{owner}/{repo}/commits``
        """
        params: dict[str, Any] = {"per_page": min(per_page, 100)}
        if sha: params["sha"] = sha

        r = self._http.get(f"/repos/{owner}/{repo}/commits", params=params)
        r.raise_for_status()
        return {"body": r.json(), "pagination": self._pagination(r)}

    # ── Releases ──────────────────────────────────────────────────────────

    def list_releases(
        self,
        owner: str,
        repo: str,
        *,
        per_page: int = 30,
    ) -> dict[str, Any]:
        """List releases for a repository.

        API: ``GET /repos/{owner}/{repo}/releases``
        """
        r = self._http.get(
            f"/repos/{owner}/{repo}/releases",
            params={"per_page": min(per_page, 100)},
        )
        r.raise_for_status()
        return {"body": r.json(), "pagination": self._pagination(r)}

    def get_latest_release(self, owner: str, repo: str) -> dict[str, Any]:
        """Get the latest published release.

        API: ``GET /repos/{owner}/{repo}/releases/latest``
        """
        r = self._http.get(f"/repos/{owner}/{repo}/releases/latest")
        r.raise_for_status()
        return r.json()

    # ── Pagination ────────────────────────────────────────────────────────

    @staticmethod
    def _pagination(response: httpx.Response) -> dict[str, Any]:
        link = response.headers.get("link", "")
        result: dict[str, Any] = {"has_next": False}
        if 'rel="next"' in link:
            result["has_next"] = True
        return result


def _client() -> GitHubReposClient:
    return GitHubReposClient()
