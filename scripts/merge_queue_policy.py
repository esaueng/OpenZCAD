"""Authorize an immutable candidate from the live, owner-only squash merge queue.

Embedded in the immutable fleet workflow: never load candidate code to decide
whether candidate code may execute on a trusted runner.
"""

import json
import os
import re
import urllib.error
import urllib.request


OWNER = "petertoday"
OWNER_ID = 171875562
REPOSITORY = "esaueng/OpenZCAD"
REPOSITORY_ID = 1334829303

QUERY = """query($owner:String!,$name:String!) {
  repository(owner:$owner,name:$name) {
    nameWithOwner databaseId isFork
    ref(qualifiedName:"refs/heads/main") { target { ... on Commit { oid } } }
    mergeQueue { entries(first:100) {
      pageInfo { hasNextPage }
      nodes {
        position state
        enqueuer { login ... on User { databaseId } }
        baseCommit { oid }
        headCommit { oid parents(first:3) { nodes { oid } } }
        pullRequest {
          number state baseRefName headRefOid isCrossRepository
          author { login ... on User { databaseId } }
          headRepository { nameWithOwner databaseId isFork }
          baseRepository { nameWithOwner databaseId isFork }
        }
      }
    } }
  }
}"""


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def owner(value):
    return value.get("login") == OWNER and value.get("databaseId") == OWNER_ID


def same_repository(value):
    return (value.get("nameWithOwner") == REPOSITORY
            and value.get("databaseId") == REPOSITORY_ID
            and value.get("isFork") is False)


def eligible(event, context):
    group = event.get("merge_group") or {}
    sender = event.get("sender") or {}
    return (
        context.get("EVENT_NAME") == "merge_group"
        and event.get("action") == "checks_requested"
        and context.get("REPOSITORY") == REPOSITORY
        and context.get("REPOSITORY_ID") == str(REPOSITORY_ID)
        and context.get("ACTOR") == OWNER
        and context.get("ACTOR_ID") == str(OWNER_ID)
        and context.get("TRIGGERING_ACTOR") == OWNER
        and sender.get("login") == OWNER and sender.get("id") == OWNER_ID
        and group.get("base_ref") == "refs/heads/main"
        and sha(group.get("base_sha")) and sha(group.get("head_sha"))
        and group.get("head_sha") == context.get("SHA")
        and group.get("head_ref") == context.get("REF")
        and re.fullmatch(r"refs/heads/gh-readonly-queue/main/pr-[1-9][0-9]*-[0-9a-f]{40}",
                         str(context.get("REF", ""))) is not None
    )


def trusted_candidate(event, context, repository, branch):
    """Bind every constituent of this exact squash candidate to live queue data."""
    if not eligible(event, context) or not same_repository(repository):
        return False
    main = ((repository.get("ref") or {}).get("target") or {}).get("oid")
    if (not sha(main) or branch.get("name") != "main"
            or branch.get("protected") is not True
            or (branch.get("commit") or {}).get("sha") != main):
        return False
    connection = ((repository.get("mergeQueue") or {}).get("entries") or {})
    if (connection.get("pageInfo") or {}).get("hasNextPage") is not False:
        return False
    nodes = connection.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return False
    previous = main
    for position, entry in enumerate(nodes, 1):
        head, base = entry.get("headCommit") or {}, entry.get("baseCommit") or {}
        pr = entry.get("pullRequest") or {}
        if (
            entry.get("position") != position
            or entry.get("state") != "AWAITING_CHECKS"
            or not owner(entry.get("enqueuer") or {})
            or not owner(pr.get("author") or {})
            or pr.get("state") != "OPEN" or pr.get("baseRefName") != "main"
            or type(pr.get("number")) is not int or pr["number"] <= 0
            or pr.get("isCrossRepository") is not False
            or not same_repository(pr.get("headRepository") or {})
            or not same_repository(pr.get("baseRepository") or {})
            or not sha(pr.get("headRefOid")) or not sha(head.get("oid"))
            or base.get("oid") != previous
            or [parent.get("oid") for parent in
                (head.get("parents") or {}).get("nodes", [])] != [previous]
        ):
            return False
        if head["oid"] == context["SHA"]:
            group = event["merge_group"]
            # GitHub can use the main tip or the preceding queue candidate as
            # the event base. Both must be in the fully verified prefix.
            return (group["base_sha"] in (main, previous)
                    and group["head_ref"] ==
                    f"refs/heads/gh-readonly-queue/main/pr-{pr['number']}-{previous}")
        previous = head["oid"]
    return False


def request(url, token, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def main():
    trusted = False
    try:
        with open(os.environ["GITHUB_EVENT_PATH"]) as stream:
            event = json.load(stream)
        if eligible(event, os.environ):
            token = os.environ["GH_TOKEN"]
            org, name = REPOSITORY.split("/")
            snapshot = request("https://api.github.com/graphql", token,
                               {"query": QUERY, "variables": {"owner": org, "name": name}})
            if not snapshot.get("errors"):
                repository = (snapshot.get("data") or {}).get("repository") or {}
                branch = request(f"https://api.github.com/repos/{REPOSITORY}/branches/main", token)
                trusted = trusted_candidate(event, os.environ, repository, branch)
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        # Missing, stale or inaccessible evidence retains hosted execution.
        # Never log credential-bearing request objects or response bodies.
        trusted = False
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("sha=" + (os.environ["SHA"] if trusted else "") + "\n")
    print("Trusted queue candidate verified" if trusted else "Use hosted CI: queue trust not established")


if __name__ == "__main__":
    main()
