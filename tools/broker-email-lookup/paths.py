#!/usr/bin/env python3
"""Shared local path configuration for broker email lookup utilities."""
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent
ARTIFACTS_DIR = Path(os.environ.get("BROKER_LOOKUP_ARTIFACTS_DIR", ROOT / "artifacts"))
ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

RAW_DIR = ROOT.parent.parent / "raw" / "broker-emails-2026-04-10"

PROGRESS_PATH = os.environ.get("PROGRESS_PATH", str(ARTIFACTS_DIR / "broker_lookup_progress.json"))
INPUT_CSV = os.environ.get(
    "INPUT_CSV",
    str(RAW_DIR / "CostarExport_MF Sales_2024-Present.xlsx - Export041026.csv"),
)
OUTPUT_CSV = os.environ.get(
    "OUTPUT_CSV",
    str(ARTIFACTS_DIR / "CoStar_Brokers_With_Emails.csv"),
)
OUTPUT_CONTACTS_CSV = os.environ.get(
    "OUTPUT_CONTACTS_CSV",
    str(ARTIFACTS_DIR / "CoStar_Broker_Contacts.csv"),
)
OUTPUT_XLSX = os.environ.get(
    "OUTPUT_XLSX",
    str(ARTIFACTS_DIR / "CostarExport_MF Sales_2024-Present_With_Emails.xlsx"),
)
