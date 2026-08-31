"""Interactive REPL: talk to the Agent yourself.

    python3 -m scripts.chat [--catalog data/catalog.jsonl]

Type a message, get the agent's reply plus its Top 10 with titles/prices.
Commands: 'reset' starts a fresh session, 'quit' / Ctrl-D exits.
"""

from __future__ import annotations

import argparse

from starter.agent import Agent

PROFILE = {
    "purchase_frequency": "monthly",
    "average_prior_rating": 4.2,
    "rating_style": "balanced",
    "preference_tags": [],
    "summary": "manual test shopper",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog.jsonl")
    args = parser.parse_args()

    print("building index (~40s)...")
    agent = Agent(args.catalog)
    session_number, turn = 1, 1
    agent.reset(f"manual-{session_number}", PROFILE)

    while True:
        try:
            message = input(f"\nturn {turn} you> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not message:
            continue
        if message in {"quit", "exit"}:
            break
        if message == "reset":
            session_number, turn = session_number + 1, 1
            agent.reset(f"manual-{session_number}", PROFILE)
            print("(new session)")
            continue

        response = agent.respond(f"manual-{session_number}", message, turn, 10)
        print(f"agent> {response['message']}")
        print(f"       ask_attribute={response.get('ask_attribute')}")
        for rank, rec in enumerate(response["recommendations"], 1):
            product = agent.products.get(rec["parent_asin"], {})
            title = str(product.get("title", "?"))[:90]
            print(f"  {rank:2}. {rec['parent_asin']}  ${product.get('price')}  {title}")
        turn += 1


if __name__ == "__main__":
    main()
