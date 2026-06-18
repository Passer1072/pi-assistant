#!/usr/bin/env python3
"""Start the Windows desktop assistant from the repository root."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DESKTOP_PACKAGE = "@earendil-works/pi-desktop-assistant"
CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent"


def command_path(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        print(f"Missing required command: {name}", file=sys.stderr)
        sys.exit(1)
    return path


def run(args: list[str], *, env: dict[str, str] | None = None) -> None:
    print(f"> {' '.join(args)}")
    subprocess.run(args, cwd=ROOT, env=env, check=True)


def run_in(path: Path, args: list[str], *, env: dict[str, str] | None = None) -> None:
    print(f"{path.relative_to(ROOT)}> {' '.join(args)}")
    subprocess.run(args, cwd=path, env=env, check=True)


def dependencies_installed() -> bool:
    return (ROOT / "node_modules" / ".package-lock.json").exists() and (
        ROOT / "node_modules" / "@earendil-works" / "pi-desktop-assistant"
    ).exists()


def build_output_exists() -> bool:
    return (ROOT / "packages" / "desktop-assistant" / "dist" / "main" / "main" / "index.js").exists() and (
        ROOT / "packages" / "desktop-assistant" / "renderer-dist" / "index.html"
    ).exists()


def newest_mtime(paths: list[Path]) -> float:
	newest = 0.0
	for path in paths:
		if path.is_file():
			newest = max(newest, path.stat().st_mtime)
		elif path.is_dir():
			for child in path.rglob("*"):
				if child.is_file():
					newest = max(newest, child.stat().st_mtime)
	return newest


def build_output_is_current() -> bool:
    main_output = ROOT / "packages" / "desktop-assistant" / "dist" / "main" / "main" / "index.js"
    renderer_output = ROOT / "packages" / "desktop-assistant" / "renderer-dist" / "index.html"
    if not main_output.exists() or not renderer_output.exists():
        return False
    source_mtime = newest_mtime(
        [
            ROOT / "packages" / "desktop-assistant" / "src",
            ROOT / "packages" / "desktop-assistant" / "renderer",
            ROOT / "packages" / "desktop-assistant" / "vite.config.ts",
            ROOT / "packages" / "desktop-assistant" / "tsconfig.build.json",
            ROOT / "packages" / "desktop-assistant" / "tsconfig.renderer.json",
        ],
    )
    return min(main_output.stat().st_mtime, renderer_output.stat().st_mtime) >= source_mtime


def electron_runtime_exists() -> bool:
    electron_dist = ROOT / "node_modules" / "electron" / "dist"
    return electron_dist.exists() and any(electron_dist.iterdir())


def ensure_electron_runtime(npm: str) -> None:
    if electron_runtime_exists():
        return
    run([npm, "exec", "--package", "electron@42.3.0", "--", "install-electron"])


def build_offline(npm: str) -> None:
    tsgo = ROOT / "node_modules" / ".bin" / ("tsgo.cmd" if os.name == "nt" else "tsgo")
    if not tsgo.exists():
        print("Missing local tsgo. Run without --skip-install so dependencies can be installed.", file=sys.stderr)
        sys.exit(1)

    packages = ROOT / "packages"
    run_in(packages / "tui", [str(tsgo), "-p", "tsconfig.build.json"])
    run_in(packages / "ai", [str(tsgo), "-p", "tsconfig.build.json"])
    run_in(packages / "agent", [str(tsgo), "-p", "tsconfig.build.json"])
    run([npm, "--workspace", CODING_AGENT_PACKAGE, "run", "build"])
    run([npm, "--workspace", DESKTOP_PACKAGE, "run", "build"])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build and launch the Pi Desktop Assistant Electron client.")
    parser.add_argument("--skip-install", action="store_true", help="Do not run npm install when node_modules is missing.")
    parser.add_argument("--skip-build", action="store_true", help="Do not build before launching Electron.")
    parser.add_argument("--rebuild", action="store_true", help="Force a full npm run build before launching Electron.")
    parser.add_argument("--dev-renderer", action="store_true", help="Start Vite for the renderer and point Electron at it.")
    parser.add_argument("--prepare-only", action="store_true", help="Install dependencies and build, then exit without launching Electron.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    npm = command_path("npm")

    if not args.skip_install and not dependencies_installed():
        run([npm, "install", "--ignore-scripts", "--legacy-peer-deps"])

    ensure_electron_runtime(npm)

    has_build_output = build_output_exists()
    build_is_current = build_output_is_current()
    if args.skip_build and not has_build_output:
        print("Desktop assistant build output is missing. Run without --skip-build first.", file=sys.stderr)
        return 1

    if args.rebuild or (not args.skip_build and not build_is_current):
        build_offline(npm)
    elif build_is_current:
        print("Desktop assistant build output exists; skipping rebuild. Use --rebuild to force it.")

    if args.prepare_only:
        print("Desktop assistant is prepared. Run without --prepare-only to launch Electron.")
        return 0

    env = os.environ.copy()
    vite_process: subprocess.Popen[str] | None = None

    try:
        if args.dev_renderer:
            env["DESKTOP_ASSISTANT_DEV_SERVER_URL"] = "http://127.0.0.1:5178"
            vite_process = subprocess.Popen(
                [npm, "--workspace", DESKTOP_PACKAGE, "run", "dev"],
                cwd=ROOT,
                env=env,
                text=True,
            )

        run([npm, "--workspace", DESKTOP_PACKAGE, "run", "electron"], env=env)
    finally:
        if vite_process is not None and vite_process.poll() is None:
            vite_process.terminate()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
