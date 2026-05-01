#!/usr/bin/env python3
"""
Backup script for the kanban app.
Creates three ZIP archives in BACKUP_SCRIPT_DIR:
  - couch-db-backup_<YYYYMMDD>.zip    — CouchDB data volume from the container
  - attachments-backup_<YYYYMMDD>.zip — local attachments folder
  - json-backup_<YYYYMMDD>.zip        — JSON export files from the data folder
"""

import os
import subprocess
import sys
import tempfile
import zipfile
from datetime import date
from pathlib import Path
from dotenv import load_dotenv

# ── Configuration ─────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent.resolve()
load_dotenv(SCRIPT_DIR / ".env")

BACKUP_DIR        = SCRIPT_DIR / os.getenv("BACKUP_SCRIPT_DIR", "backup")
DATA_DIR          = SCRIPT_DIR / os.getenv("BACKUP_DIR", "data")
ATTACHMENTS_DIR   = DATA_DIR / "attachments"
JSON_DIR          = DATA_DIR / "json"
COUCHDB_MOUNT_DIR = DATA_DIR / "couchdb"
COMPOSE_DIR       = SCRIPT_DIR
COUCHDB_DATA_PATH = os.getenv("COUCHDB_DATA_PATH", "/opt/couchdb/data")
COUCHDB_SERVICE   = os.getenv("COUCHDB_SERVICE", "couchdb")

# ── Helpers ───────────────────────────────────────────────────────────────────

def run(cmd, **kwargs):
    result = subprocess.run(cmd, check=True, capture_output=True, text=True, **kwargs)
    return result.stdout.strip()

def zip_dir(src: Path, dest: Path):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in src.rglob("*"):
            if file.is_file():
                zf.write(file, file.relative_to(src))
    size_mb = dest.stat().st_size / (1024 * 1024)
    print(f"  → {dest.name}  ({size_mb:.1f} MB)")

def zip_files(files: list, dest: Path):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in files:
            zf.write(file, file.name)
    size_mb = dest.stat().st_size / (1024 * 1024)
    print(f"  → {dest.name}  ({size_mb:.1f} MB)")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    today = date.today().strftime("%Y%m%d")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    COUCHDB_MOUNT_DIR.mkdir(parents=True, exist_ok=True)

    # ── 1. CouchDB backup ─────────────────────────────────────────────────────
    print("Backing up CouchDB …")
    try:
        container_id = run(
            ["docker", "compose", "ps", "-q", COUCHDB_SERVICE],
            cwd=COMPOSE_DIR,
        )
        if not container_id:
            raise RuntimeError("CouchDB container not found — is it running?")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp) / "couchdb-data"
            run(["docker", "cp", f"{container_id}:{COUCHDB_DATA_PATH}", str(tmp_path)])
            dest = BACKUP_DIR / f"couch-db-backup_{today}.zip"
            zip_dir(tmp_path, dest)

    except subprocess.CalledProcessError as e:
        print(f"  ERROR: {e.stderr or e}", file=sys.stderr)
        sys.exit(1)
    except RuntimeError as e:
        print(f"  ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    # ── 2. Attachments backup ─────────────────────────────────────────────────
    print("Backing up attachments …")
    if not ATTACHMENTS_DIR.exists():
        print(f"  WARNING: {ATTACHMENTS_DIR} does not exist — skipping.")
    else:
        dest = BACKUP_DIR / f"attachments-backup_{today}.zip"
        zip_dir(ATTACHMENTS_DIR, dest)

    # ── 3. JSON exports backup ────────────────────────────────────────────────
    print("Backing up JSON exports …")
    json_files = sorted(JSON_DIR.glob("*.json"))
    if not json_files:
        print(f"  WARNING: no JSON files found in {JSON_DIR} — skipping.")
    else:
        dest = BACKUP_DIR / f"json-backup_{today}.zip"
        zip_files(json_files, dest)

    print("Done.")

if __name__ == "__main__":
    main()
