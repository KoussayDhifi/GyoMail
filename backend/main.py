from fastapi import FastAPI
from db import redis_client
from models.email import EmailRequest
from models.email import EmailBatch
from fastapi.middleware.cors import CORSMiddleware

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
    for email in payload.emails:
        print(f"Received email: {email}")
    return {"Emails": payload.emails}


@app.post("/classify-email")
async def classify_email(email: EmailRequest):
    # Here you can implement your classification logic
    print(f"Classifying email: {email}")
    return {"message": "Email classified successfully", "email": email}