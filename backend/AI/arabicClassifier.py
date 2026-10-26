
import os

import torch
from arabert.preprocess import ArabertPreprocessor
from transformers import AutoModelForSequenceClassification, AutoTokenizer


MODEL_ID = os.getenv(
    "GYOMAIL_ARABIC_MODEL",
    "YOUR_HF_USERNAME/gyomail-arabic-phishing-arabert",
)
BASE_MODEL = "aubmindlab/bert-base-arabertv02"
MAX_LENGTH = 512

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

preprocessor = None
tokenizer = None
model = None


def load_arabic_model():
    global preprocessor, tokenizer, model

    if model is not None:
        return

    preprocessor = ArabertPreprocessor(model_name=BASE_MODEL)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID)

    model.to(device)
    model.eval()


def classify_arabic_text(text: str) -> dict:
    if not text or not text.strip():
        raise ValueError("Email contains no classifiable text.")

    load_arabic_model()

    processed = preprocessor.preprocess(text)

    inputs = tokenizer(
        processed,
        return_tensors="pt",
        truncation=True,
        max_length=MAX_LENGTH,
    )
    inputs = {key: value.to(device) for key, value in inputs.items()}

    with torch.inference_mode():
        logits = model(**inputs).logits
        probabilities = torch.softmax(logits, dim=-1)[0]

    phishing_probability = float(probabilities[1].item())

    if phishing_probability >= 0.5:
        return {
            "label": "Phishing",
            "score": phishing_probability,
        }

    return {
        "label": "Legitimate",
        "score": 1.0 - phishing_probability,
    }
