from fastapi import FastAPI
from db import redis_client, get_cached_classification, save_classification
from models.email import EmailRequest
from models.email import EmailBatch
from fastapi.middleware.cors import CORSMiddleware
from AILayer import classify_email as classify_email_logic

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        cached = get_cached_classification(email.id)

        if cached:
            results.append({
                "email_id": email.id,
                "label": cached["label"],
                "score": float(cached["score"]),
                "body_analyzed": cached["body_analyzed"] == "true",
            })
            continue

        result = classify_email_logic(email)
        body_analyzed = bool(email.body and email.body.strip())

        save_classification(email.id, result, body_analyzed)

        results.append({
            "email_id": email.id,
            "label": result["label"],
            "score": result["score"],
            "body_analyzed": body_analyzed,
        })

    return {"Results": results}


@app.post("/classify-email")
async def classify_email(email: EmailRequest):
    cached = get_cached_classification(email.id)

    has_body = bool(email.body and email.body.strip())

    if cached and (
        cached["body_analyzed"] == "true" or not has_body
    ):
        return {
            "message": "Email already classified",
            "email": email,
            "classification": {
                "label": cached["label"],
                "score": float(cached["score"]),
            },
        }

    classification_result = classify_email_logic(email)

    save_classification(
        email.id,
        classification_result,
        body_analyzed=has_body,
    )

    return {
        "message": "Email classified successfully",
        "email": email,
        "classification": classification_result,
    }