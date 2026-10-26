
import re

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import (
    redis_client,
    get_cached_classification,
    save_classification,
)
from models.email import EmailRequest, EmailBatch
from AI.AILayer import classify_email as classify_email_logic


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


_GMAIL_DOM_ID = re.compile(
    r"^#?(?:thread|msg)-[a-z]:(\d+)$",
    re.IGNORECASE,
)

FRENCH_WARNING = (
    "GyoMail's phishing detection is primarily optimized for English. "
    "Results for French emails may be less reliable."
)


def _is_true(value) -> bool:
    """Handle Redis boolean values returned as strings or bytes."""
    if isinstance(value, bytes):
        value = value.decode()

    return str(value).strip().lower() == "true"


def normalize_email_id(raw_id: str) -> str:
    """Normalize Gmail decimal and hexadecimal IDs to the same cache key."""
    raw_id = raw_id.strip()
    match = _GMAIL_DOM_ID.match(raw_id)

    if match:
        return format(int(match.group(1)), "x")

    return raw_id.lower()


def _language_metadata(result: dict) -> dict:
    """Normalize language metadata and generate the French warning."""
    language = str(
        result.get("detected_language") or "other"
    ).strip().lower()

    warning = result.get("language_warning")
    if isinstance(warning, str):
        warning = warning.strip() or None
    else:
        warning = None

    if language in {"fr", "fra", "fra_latn"} and not warning:
        warning = FRENCH_WARNING

    return {
        "detected_language": language,
        "language_warning": warning,
    }


def classify_with_cache(email: EmailRequest) -> tuple[dict, bool]:
    """
    Return (result, from_cache).

    A full-body classification takes priority over a snippet-only result.
    Language metadata is preserved whenever it is available.
    """
    has_body = bool(email.body and email.body.strip())
    cache_id = normalize_email_id(email.id)

    cached = get_cached_classification(cache_id)

    if cached:
        cached_has_body = _is_true(cached.get("body_analyzed", False))

        if cached_has_body or not has_body:
            result = {
                "email_id": email.id,
                "label": cached["label"],
                "score": float(cached["score"]),
                "body_analyzed": cached_has_body,
                **_language_metadata(cached),
            }

            return result, True

    # A fresh classification should include language metadata from AILayer.
    classified = classify_email_logic(email)

    result = {
        "email_id": email.id,
        "label": classified["label"],
        "score": float(classified["score"]),
        "body_analyzed": has_body,
        **_language_metadata(classified),
    }

    # db.py must persist detected_language and language_warning too.
    save_classification(
        cache_id,
        result,
        body_analyzed=has_body,
    )

    return result, False


@app.get("/")
async def read_root():
    return {
        "Welcome": "If you get this message, the API is working.",
        "Database": (
            "Redis is connected"
            if redis_client.ping()
            else "Redis is not connected"
        ),
    }


@app.post("/send-email")
async def send_email(payload: EmailBatch):
    results = []

    for email in payload.emails:
        entry, _ = classify_with_cache(email)
        results.append(entry)

    return {"Results": results}


@app.post("/classify-email")
async def classify_email(email: EmailRequest):
    entry, from_cache = classify_with_cache(email)

    return {
        "message": (
            "Email already classified"
            if from_cache
            else "Email classified successfully"
        ),
        "email": email,
        "classification": {
            "label": entry["label"],
            "score": entry["score"],
            "detected_language": entry["detected_language"],
            "language_warning": entry["language_warning"],
        },
    }
