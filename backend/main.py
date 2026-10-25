from fastapi import FastAPI
from db import redis_client, get_cached_classification, save_classification
from models.email import EmailRequest
from models.email import EmailBatch
from fastapi.middleware.cors import CORSMiddleware
from AI.AILayer import classify_email as classify_email_logic

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _is_true(value) -> bool:
    """Redis gives back strings (or bytes), so 'true' / 'True' / b'true' all count."""
    if isinstance(value, bytes):
        value = value.decode()
    return str(value).strip().lower() == "true"


def classify_with_cache(email: EmailRequest) -> tuple[dict, bool]:
    """Return (result, from_cache). Both endpoints use this, so the rule lives in one place.

    Priority: a result computed from the BODY always beats one computed from the
    snippet only.
      - cached with body                -> reuse it, whatever this request contains
      - cached snippet-only, no body now -> reuse it (nothing new to analyze)
      - cached snippet-only, body now    -> classify again and overwrite the cache
      - nothing cached                   -> classify and store
    """
    has_body = bool(email.body and email.body.strip())
    cached = get_cached_classification(email.id)

    if cached:
        cached_has_body = _is_true(cached["body_analyzed"])

        if cached_has_body or not has_body:
            return {
                "email_id": email.id,
                "label": cached["label"],
                "score": float(cached["score"]),
                "body_analyzed": cached_has_body,
            }, True

    result = classify_email_logic(email)
    save_classification(email.id, result, body_analyzed=has_body)

    return {
        "email_id": email.id,
        "label": result["label"],
        "score": result["score"],
        "body_analyzed": has_body,
    }, False


@app.get("/")
async def read_root():
    return {
    "Welcome": "If you get this message means the API  is working",
    "Database": "Redis is connected" if redis_client.ping() else "Redis is not connected"
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
        },
    }