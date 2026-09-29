"""Module entry point so plugins can call ``python -m evoontology.visualization``.

Mirrors the ``python -m evoontology.validate`` convention used by the Build
and Evolve commands. Thin wrapper over :func:`evoontology.visualization.visualize`.
"""

from __future__ import annotations

import argparse

from .renderer import ACTIVE, visualize


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render all ontology versions as one standalone interactive HTML explorer."
    )
    parser.add_argument(
        "--root",
        default=None,
        help=(
            "Exact workspace, .evoontology container, or project root "
            "(default: <cwd>/.evoontology)"
        ),
    )
    parser.add_argument(
        "--version",
        default=ACTIVE,
        help="Ontology version initially shown (default: active version)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not open the generated HTML in a browser",
    )
    args = parser.parse_args()
    output = visualize(workspace=args.root, version=args.version, open_browser=not args.no_browser)
    print(output)


if __name__ == "__main__":
    main()
