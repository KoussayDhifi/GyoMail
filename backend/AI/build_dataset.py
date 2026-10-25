"""
Build one training dataset from the six raw CSVs of the phishing email dataset.

Usage:
    python build_dataset.py --dir path/to/csv_folder --out dataset.csv

Output columns: id, source, label, text, split   (split = train / val / test)

The text is built like your concatenate_email, but with subject and body only:

    Subject:
    ...

    Email body:
    ...

Use the SAME cleaning and layout in production (see build_text below).
"""
import argparse
import re
import unicodedata
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

# source -> accepted file names (compared in lowercase)
SOURCES = {
    "ceas": ["ceas_08.csv"],
    "enron": ["enron.csv"],
    "ling": ["ling.csv"],
    "nazario": ["nazario.csv"],
    "nigerian": ["nigerian_fraud.csv"],
    "spamassassin": ["spamassasin.csv", "spamassassin.csv", "spanassistant.csv"],
}

# Enron and Ling are stored lowercased with spaces around punctuation
# ("( see attached file : hplno 525 . xls )"). The other sources are natural text.
PRE_TOKENIZED = {"enron", "ling"}

# Mailbox bookkeeping messages ("This text is part of the internal format of
# your mail folder...") that appear in Nazario / SpamAssassin. Not real emails.
JUNK_RE = re.compile(r"internal format of your mail folder|folder internal data", re.I)


# ---- your cleaning code, copied without the model loading -------------------
class EmailHTMLParser(HTMLParser):
    BLOCK_TAGS = {
        "address", "article", "blockquote", "div", "footer",
        "h1", "h2", "h3", "h4", "h5", "h6", "header",
        "li", "main", "ol", "p", "section", "table", "tr", "ul",
    }
    SKIP_TAGS = {"script", "style", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0
        self.link_stack = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in self.SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")
        if tag == "br":
            self.parts.append("\n")
        elif tag == "img":
            alt = (attrs.get("alt") or "").strip()
            if alt:
                self.parts.append(f" {alt} ")
        elif tag == "a":
            self.link_stack.append((attrs.get("href") or "").strip())

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag == "a" and self.link_stack:
            href = self.link_stack.pop()
            if href:
                self.parts.append(f" (link: {href}) ")
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)

    def get_text(self):
        return "".join(self.parts)


def clean_email_text(value) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return ""
    value = unescape(str(value))
    parser = EmailHTMLParser()
    try:
        parser.feed(value)
        parser.close()
        text = unescape(parser.get_text())
    except Exception:
        text = value
    text = unicodedata.normalize("NFKC", text).replace("\xa0", " ")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[^\S\n]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def detokenize(text: str) -> str:
    """Undo the 'space around punctuation' tokenization (best effort)."""
    text = re.sub(r"\s+([.,;:!?%)\]}])", r"\1", text)
    text = re.sub(r"([(\[{$])\s+", r"\1", text)
    text = re.sub(r"\s*'\s*(s|t|re|ll|ve|d|m)\b", r"'\1", text)
    return text


def lower_keep_headers(t: str) -> str:
    """Lowercase an email text but keep the 'Subject:' / 'Email body:' headers."""
    t = t.lower()
    if t.startswith("subject:\n"):
        t = "Subject:" + t[len("subject:"):]
    t = t.replace("\n\nemail body:\n", "\n\nEmail body:\n", 1)
    if t.startswith("email body:\n"):
        t = "Email body:" + t[len("email body:"):]
    return t


def build_text(subject, body, max_body_chars=5000, detok=False) -> str:
    """Same layout as concatenate_email, minus sender and snippet."""
    subject = clean_email_text(subject)
    body = clean_email_text(body)[:max_body_chars]
    if detok:
        subject, body = detokenize(subject), detokenize(body)
    sections = []
    if subject:
        sections.append(f"Subject:\n{subject}")
    if body:
        sections.append(f"Email body:\n{body}")
    return "\n\n".join(sections)


# ---- dataset building -------------------------------------------------------
def load_source(path: Path, source: str) -> pd.DataFrame:
    df = pd.read_csv(path, encoding_errors="replace", dtype=str)
    df.columns = [c.strip().lower() for c in df.columns]
    df = df.rename(columns={"lable": "label"})  # Ling.csv spells it "Lable"
    missing = {"subject", "body", "label"} - set(df.columns)
    if missing:
        raise ValueError(f"{path.name}: missing columns {missing}; has {list(df.columns)}")
    df = df[["subject", "body", "label"]].copy()
    df["label"] = pd.to_numeric(df["label"], errors="coerce")
    df = df.dropna(subset=["label"])
    df["label"] = df["label"].astype(int)
    df["source"] = source
    return df


def dedupe_key(text: str) -> str:
    """Lowercase, digits -> 0, whitespace collapsed: catches templated near-copies."""
    return re.sub(r"\s+", " ", re.sub(r"\d+", "0", text.lower())).strip()


def report_raw(df: pd.DataFrame) -> None:
    """Show whether each source looks raw or already stripped/lowercased."""
    print("\nRaw data check (is the text still natural?)")
    print(f"{'source':<14}{'rows':>8}{'spam%':>8}{'has upper%':>12}{'has punct%':>12}{'has http%':>11}")
    for src, g in df.groupby("source"):
        body = g["body"].fillna("")
        print(f"{src:<14}{len(g):>8}{g['label'].mean()*100:>8.1f}"
              f"{body.str.contains(r'[A-Z]').mean()*100:>12.1f}"
              f"{body.str.contains(r'[.,!?:;]').mean()*100:>12.1f}"
              f"{body.str.contains('http', case=False).mean()*100:>11.1f}")
    print("If a source shows ~0% uppercase and ~0% punctuation, it is pre-stripped.\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="folder containing the raw CSVs")
    ap.add_argument("--out", default="dataset.csv")
    ap.add_argument("--exclude", nargs="*", default=[],
                    help="sources to leave out, e.g. --exclude enron ling")
    ap.add_argument("--lowercase-frac", type=float, default=0.3,
                    help="share of natural-case TRAIN rows to lowercase, so the model "
                         "cannot use letter case as a shortcut (0 to disable)")
    args = ap.parse_args()

    available = {p.name.lower(): p for p in Path(args.dir).iterdir() if p.is_file()}
    frames = []
    for source, names in SOURCES.items():
        if source in args.exclude:
            continue
        found = next((available[n] for n in names if n in available), None)
        if found is None:
            print(f"skip {source}: none of {names} found in {args.dir}")
            continue
        frames.append(load_source(found, source))
    df = pd.concat(frames, ignore_index=True)
    report_raw(df)

    junk = df["body"].fillna("").str.contains(JUNK_RE)
    print(f"Dropping {int(junk.sum())} mailbox-internal junk rows")
    df = df[~junk].copy()

    df["text"] = [build_text(s, b, detok=(src in PRE_TOKENIZED))
                  for s, b, src in zip(df["subject"], df["body"], df["source"])]
    before = len(df)
    df = df[df["text"].str.len() >= 20]
    df = df.drop_duplicates(subset="text")
    df["key"] = df["text"].map(dedupe_key)
    df = df.drop_duplicates(subset="key")
    print(f"Rows: {before} -> {len(df)} after dropping empty, short and duplicate texts")

    df = df.reset_index(drop=True)
    df["id"] = df.index
    train_idx, rest_idx = train_test_split(
        df.index, test_size=0.2, stratify=df["label"], random_state=42)
    val_idx, test_idx = train_test_split(
        rest_idx, test_size=0.5, stratify=df.loc[rest_idx, "label"], random_state=42)
    df["split"] = "train"
    df.loc[val_idx, "split"] = "val"
    df.loc[test_idx, "split"] = "test"

    if args.lowercase_frac > 0:
        rng = np.random.default_rng(42)
        mask = ((df["split"] == "train")
                & ~df["source"].isin(PRE_TOKENIZED)
                & (rng.random(len(df)) < args.lowercase_frac))
        df.loc[mask, "text"] = df.loc[mask, "text"].map(lower_keep_headers)
        print(f"\nLowercased {int(mask.sum())} natural-case train rows (augmentation)")

    print("\nFinal counts (rows by source and label):")
    print(pd.crosstab(df["source"], df["label"]))
    print("\nSplit sizes:", df["split"].value_counts().to_dict())

    print("\nOne sample per source (eyeball these):")
    for src, g in df.groupby("source"):
        print(f"--- {src} ---\n{g['text'].iloc[0][:250]}\n")

    df[["id", "source", "label", "text", "split"]].to_csv(args.out, index=False)
    print(f"Saved to {args.out}")


if __name__ == "__main__":
    main()