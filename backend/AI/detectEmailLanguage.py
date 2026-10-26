
from functools import lru_cache

import torch
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
)

from models.email import EmailRequest
from AI.preprocess import clean_email_text


MODEL_NAME = "Horizon-Labs/language-detection-small"
MIN_CONFIDENCE = 0.60
MAX_INPUT_CHARS = 3000

# Model labels for the three languages GyoMail supports.
ALLOWED_LANGUAGES = {
    "eng_Latn": "en",
    "fra_Latn": "fr",
    "arb_Arab": "ar",
}


@lru_cache(maxsize=1)
def get_language_detector():
    """Load the multilingual language detector once."""
    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME
    ).eval()

    label2id = model.config.label2id

    # Validate labels instead of silently using incorrect IDs.
    missing = [
        label for label in ALLOWED_LANGUAGES
        if label not in label2id
    ]

    if missing:
        raise ValueError(
            f"Expected language labels not found: {missing}. "
            f"Available labels include: "
            f"{list(label2id.keys())[:20]}"
        )

    allowed_ids = {
        label2id[label]: language
        for label, language in ALLOWED_LANGUAGES.items()
    }

    return tokenizer, model, allowed_ids


def detect_email_language(email: EmailRequest) -> str:
    """
    Detect the email language.

    Returns:
        'ar'    Arabic
        'fr'    French
        'en'    English
        'other' Another language or an uncertain prediction
    """
    parts = [
        clean_email_text(email.subject or ""),
        clean_email_text(email.snippet or ""),
        clean_email_text(email.body or ""),
    ]

    text = "\n".join(part for part in parts if part).strip()

    if not text:
        return "other"

    text = text[:MAX_INPUT_CHARS]

    tokenizer, model, allowed_ids = get_language_detector()

    inputs = tokenizer(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=128,
    )

    with torch.no_grad():
        logits = model(**inputs).logits[0]

        # Exclude every language except English, French, and Arabic.
        mask = torch.full_like(logits, float("-inf"))
        for language_id in allowed_ids:
            mask[language_id] = logits[language_id]

        probabilities = torch.softmax(mask, dim=-1)
        predicted_id = int(probabilities.argmax().item())
        confidence = float(probabilities[predicted_id].item())

    language = allowed_ids[predicted_id]

   

    if confidence < MIN_CONFIDENCE:
        return "other"

    return language
