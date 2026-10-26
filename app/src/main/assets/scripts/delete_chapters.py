#!/usr/bin/env python3
import argparse
import re
import sys
from pathlib import Path

CHAPTER_RE = re.compile(r"(?i)\bchapter[\s_-]*(\d+)\b")

def main():
    parser = argparse.ArgumentParser(
        description="Delete chapter text files up to a specified chapter number."
    )
    parser.add_argument("folder", help="Folder containing the chapter text files")
    parser.add_argument("chapter", type=int, help="Delete chapters 1 through this number")
    parser.add_argument(
        "--yes", "-y",
        action="store_true",
        help="Delete without asking for confirmation"
    )
    args = parser.parse_args()

    if args.chapter < 1:
        print("Error: chapter number must be 1 or greater.")
        sys.exit(1)

    folder = Path(args.folder).expanduser()

    if not folder.is_dir():
        print(f"Error: folder does not exist: {folder}")
        sys.exit(1)

    matches = []

    # Only checks files directly inside the selected folder.
    for file in folder.iterdir():
        if not file.is_file() or file.suffix.lower() != ".txt":
            continue

        match = CHAPTER_RE.search(file.name)
        if not match:
            continue

        chapter_number = int(match.group(1))

        if chapter_number <= args.chapter:
            matches.append((chapter_number, file))

    matches.sort(key=lambda item: (item[0], item[1].name.lower()))

    if not matches:
        print(f"No .txt files for chapters 1 through {args.chapter} were found.")
        return

    print(f"Files that will be deleted (chapters 1-{args.chapter}):")
    for chapter_number, file in matches:
        print(f"  Chapter {chapter_number}: {file.name}")

    if not args.yes:
        answer = input(f"\nDelete these {len(matches)} file(s)? [y/N]: ").strip().lower()
        if answer not in ("y", "yes"):
            print("Cancelled. Nothing was deleted.")
            return

    deleted = 0
    for _, file in matches:
        try:
            file.unlink()
            deleted += 1
        except OSError as e:
            print(f"Could not delete {file.name}: {e}")

    print(f"\nDeleted {deleted} file(s).")

if __name__ == "__main__":
    main()
