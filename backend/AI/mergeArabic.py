from pathlib import Path
import re
import unicodedata

import pandas as pd


# ============================================================
# Configuration
# ============================================================

BASE_DIR = Path(__file__).resolve().parent
DATASETS_DIR = BASE_DIR / "datasets"

EXCEL_FILE = DATASETS_DIR / "arabic_phishing.xlsx"
PHISHING_CSV = DATASETS_DIR / "phishing-bilingual.csv"
LEGITIMATE_CSV = DATASETS_DIR / "legit-bilingual.csv"

OUTPUT_CSV = DATASETS_DIR / "arabic_merged.csv"
OUTPUT_JSONL = DATASETS_DIR / "arabic_merged.jsonl"
CONFLICTS_CSV = DATASETS_DIR / "label_conflicts_review.csv"

# Excel columns
EXCEL_TEXT_COL = "محتوى الإيميل"
EXCEL_TYPE_COL = "نوع الإيميل"

# CSV columns
CSV_ARABIC_COL = "Arabic Text"

# Labels
LEGITIMATE_LABEL = 0
PHISHING_LABEL = 1


# ============================================================
# Utility functions
# ============================================================

def read_csv_checked(path: Path) -> pd.DataFrame:
    """Read a CSV file and validate that it exists."""
    if not path.exists():
        raise FileNotFoundError(
            f"File not found: {path}\n"
            "Check the filename and make sure the file is inside "
            f"'{DATASETS_DIR}'."
        )

    return pd.read_csv(path, encoding="utf-8-sig")


def clean_text(value) -> str:
    """Normalize Unicode and whitespace without removing Arabic characters."""
    if pd.isna(value):
        return ""

    text = unicodedata.normalize("NFC", str(value))
    text = text.replace("\ufeff", " ")
    text = re.sub(r"\s+", " ", text).strip()

    return text


def dedup_key(text: str) -> str:
    """Create a key for exact-text duplicate detection."""
    return re.sub(r"\s+", " ", text).strip().casefold()


def validate_columns(
    df: pd.DataFrame,
    required_columns: list[str],
    filename: str,
) -> None:
    """Raise a useful error if required columns are missing."""
    missing = [col for col in required_columns if col not in df.columns]

    if missing:
        raise ValueError(
            f"Missing columns in {filename}: {missing}\n"
            f"Available columns: {df.columns.tolist()}"
        )


def show_class_counts(df: pd.DataFrame, title: str) -> None:
    """Display the number of examples in each class."""
    counts = df["label"].value_counts().sort_index()

    print(f"\n{title}")
    print(f"  Legitimate (0): {counts.get(0, 0)}")
    print(f"  Phishing   (1): {counts.get(1, 0)}")
    print(f"  Total         : {len(df)}")


# ============================================================
# Main
# ============================================================

def main() -> None:
    print("Loading datasets...")

    # --------------------------------------------------------
    # 1. Load files
    # --------------------------------------------------------

    if not EXCEL_FILE.exists():
        raise FileNotFoundError(f"Excel file not found: {EXCEL_FILE}")

    excel = pd.read_excel(EXCEL_FILE)
    phishing = read_csv_checked(PHISHING_CSV)
    legitimate = read_csv_checked(LEGITIMATE_CSV)

    print("\nDataset columns:")
    print(f"Excel:              {excel.columns.tolist()}")
    print(f"Phishing CSV:       {phishing.columns.tolist()}")
    print(f"Legitimate CSV:     {legitimate.columns.tolist()}")

    # --------------------------------------------------------
    # 2. Validate columns
    # --------------------------------------------------------

    validate_columns(
        excel,
        [EXCEL_TEXT_COL, EXCEL_TYPE_COL],
        EXCEL_FILE.name,
    )

    validate_columns(
        phishing,
        [CSV_ARABIC_COL],
        PHISHING_CSV.name,
    )

    validate_columns(
        legitimate,
        [CSV_ARABIC_COL],
        LEGITIMATE_CSV.name,
    )

    # --------------------------------------------------------
    # 3. Label Excel records from the type column
    # --------------------------------------------------------

    types = excel[EXCEL_TYPE_COL].fillna("").astype(str).str.strip()

    is_phishing = types.str.match(
        r"(?i)^phish(?:ing)?\s+email\s*[-#:]?\s*\d+\s*$"
    )

    is_legitimate = types.str.match(
        r"(?i)^legal\s+email\s*[-#:]?\s*\d+\s*$"
    )

    unknown = ~(is_phishing | is_legitimate)

    if unknown.any():
        examples = types[unknown].unique()[:20]

        raise ValueError(
            "Unexpected values in the Excel type column. "
            "Review these values before assigning labels:\n"
            f"{examples.tolist()}"
        )

    excel_clean = pd.DataFrame({
        "text": excel[EXCEL_TEXT_COL].map(clean_text),
        "label": is_phishing.astype(int),
        "source": "excel_arabic_emails",
    })

    # --------------------------------------------------------
    # 4. Prepare the phishing CSV
    # --------------------------------------------------------

    phishing_clean = pd.DataFrame({
        "text": phishing[CSV_ARABIC_COL].map(clean_text),
        "label": PHISHING_LABEL,
        "source": "csv_phishing",
    })

    # --------------------------------------------------------
    # 5. Prepare the legitimate CSV
    # --------------------------------------------------------

    legitimate_clean = pd.DataFrame({
        "text": legitimate[CSV_ARABIC_COL].map(clean_text),
        "label": LEGITIMATE_LABEL,
        "source": "csv_legitimate",
    })

    # --------------------------------------------------------
    # 6. Merge datasets
    # --------------------------------------------------------

    df = pd.concat(
        [excel_clean, phishing_clean, legitimate_clean],
        ignore_index=True,
    )

    original_count = len(df)

    # Remove empty email bodies
    df = df[df["text"].str.len() > 0].copy()

    empty_removed = original_count - len(df)

    print(f"\nEmpty records removed: {empty_removed}")

    # Ensure labels are integers
    df["label"] = df["label"].astype("int64")

    show_class_counts(df, "Counts before deduplication:")

    # --------------------------------------------------------
    # 7. Detect conflicting labels
    # --------------------------------------------------------

    df["dedup_key"] = df["text"].map(dedup_key)

    labels_per_text = df.groupby("dedup_key")["label"].nunique()
    conflicting_keys = labels_per_text[labels_per_text > 1].index

    if len(conflicting_keys) > 0:
        conflicts = df[df["dedup_key"].isin(conflicting_keys)].copy()
        conflicts = conflicts.drop(columns=["dedup_key"])

        conflicts.to_csv(
            CONFLICTS_CSV,
            index=False,
            encoding="utf-8-sig",
        )

        raise ValueError(
            f"\nFound {len(conflicting_keys)} email texts assigned "
            "conflicting labels.\n"
            f"Review: {CONFLICTS_CSV}\n"
            "Resolve these labels before training."
        )

    # --------------------------------------------------------
    # 8. Remove duplicate Arabic email texts
    # --------------------------------------------------------

    before_dedup = len(df)

    # Keep the first occurrence when the same text appears
    # in multiple datasets with the same label.
    df = df.drop_duplicates(subset=["dedup_key"], keep="first").copy()

    duplicates_removed = before_dedup - len(df)

    print(f"\nDuplicate records removed: {duplicates_removed}")

    # Remove internal deduplication column
    df = df.drop(columns=["dedup_key"])

    # --------------------------------------------------------
    # 9. Shuffle the dataset
    # --------------------------------------------------------

    df = df.sample(frac=1, random_state=42).reset_index(drop=True)

    # Keep only the columns needed for the dataset
    df = df[["text", "label", "source"]]

    # --------------------------------------------------------
    # 10. Save CSV and JSONL
    # --------------------------------------------------------

    DATASETS_DIR.mkdir(parents=True, exist_ok=True)

    df.to_csv(
        OUTPUT_CSV,
        index=False,
        encoding="utf-8-sig",
    )

    df.to_json(
        OUTPUT_JSONL,
        orient="records",
        lines=True,
        force_ascii=False,
    )

    # --------------------------------------------------------
    # 11. Final report
    # --------------------------------------------------------

    show_class_counts(df, "Final dataset:")

    print("\nSources:")
    print(df["source"].value_counts().to_string())

    print("\nFiles created:")
    print(f"CSV:   {OUTPUT_CSV}")
    print(f"JSONL: {OUTPUT_JSONL}")

    print("\nDone.")


if __name__ == "__main__":
    main()