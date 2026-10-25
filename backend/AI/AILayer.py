from transformers import pipeline
from models.email import EmailRequest
import re
import unicodedata
from html import unescape
from html.parser import HTMLParser
import math
import os
from functools import lru_cache
import unicodedata
from AI.preprocess import clean_text,preprocess_email
import joblib

ENGINE = os.environ.get("GYO_ENGINE", "finetuned")

SVM_MODEL_PATH = os.environ.get("GYO_SVM_PATH", "AI/models/phishing_svm.joblib")

SVM_INCLUDE_SENDER = False


FINETUNED_REPO = os.environ.get("GYO_MODEL_REPO", "PepperMintButler/GyoMail")
FINETUNED_MAX_LEN = 256
# Emails with P(Phishing) >= this are labeled Phishing. Pick it from the
# threshold table printed at the end of training (higher = fewer false alarms).
# Note: above 0.5, a "Legitimate" verdict can come with a low score.
FINETUNED_THRESHOLD = 0.5

CLASS_LABELS = [
    "Phishing",
    "Legitimate"
]

@lru_cache(maxsize=1)
def _zero_shot_pipeline():
    # Imported lazily so the big model is only downloaded/loaded when used.
    from transformers import pipeline
    return pipeline(
        task="zero-shot-classification",
        model="facebook/bart-large-mnli",
        tokenizer="facebook/bart-large-mnli"
    )
 
 
@lru_cache(maxsize=1)
def _svm_model():
    return joblib.load(SVM_MODEL_PATH)

GyoClassifier = pipeline(
    task="zero-shot-classification",
    model="facebook/bart-large-mnli",
    tokenizer="facebook/bart-large-mnli"
)


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
            alt = attrs.get("alt", "").strip()
            if alt:
                self.parts.append(f" {alt} ")

        elif tag == "a":
            self.link_stack.append(attrs.get("href", "").strip())

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


def clean_email_text(value: str | None) -> str:
    if not value:
        return ""

    # Decode entities such as &amp;, &#x20;, and &nbsp;.
    value = unescape(value)

    # Extract readable text from HTML while retaining anchor destinations.
    parser = EmailHTMLParser()
    parser.feed(value)
    parser.close()

    text = unescape(parser.get_text())

    # Normalize Unicode, including unusual whitespace characters.
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("\xa0", " ")

    # Normalize line endings and collapse excessive blank lines.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[^\S\n]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()

@lru_cache(maxsize=1)
def _fine_tuned_pipeline():
    # The first call downloads the model (~330 MB) into the local Hugging Face
    # cache; later runs load it from disk. Call this once at server startup so
    # the first request is not slow.
    
    import torch
    from transformers import pipeline
 
    return pipeline(
        "text-classification",
        model=FINETUNED_REPO,
        token=os.environ.get("HF_TOKEN") or None,
        device=0 if torch.cuda.is_available() else -1,
    )

def concatenate_email(email: EmailRequest) -> str:

    sender_name = clean_email_text(email.sender.name)
    sender_address = clean_email_text(email.sender.email)
    subject = clean_email_text(email.subject)
    snippet = clean_email_text(email.snippet)
    body = clean_email_text(email.body)

    sections = []

    if sender_name or sender_address:
        sender = sender_name or "Unknown"
        if sender_address:
            sender += f" <{sender_address}>"
        sections.append(f"Sender:\n{sender}")

    if subject:
        sections.append(f"Subject:\n{subject}")

    # Gmail snippets frequently repeat the beginning of the body.
    # Include the preview when it adds information not found in the body.
    if snippet and (
        not body
        or snippet.casefold() not in body.casefold()
    ):
        sections.append(f"Email preview:\n{snippet}")

    if body:
        sections.append(f"Email body:\n{body}")

    return "\n\n".join(sections)




def _classify_zero_shot(email: EmailRequest) -> dict:
    text = concatenate_email(email)
 
    if not text:
        raise ValueError("Email contains no classifiable text.")
 
    result = _zero_shot_pipeline()(
        text,
        candidate_labels=CLASS_LABELS,
        hypothesis_template="This email is {}."
    )
 
    best_idx = result["scores"].index(max(result["scores"]))
 
    return {
        "email_id": email.id,
        "label": result["labels"][best_idx],
        "score": result["scores"][best_idx],
    }



def _classify_svm(email: EmailRequest) -> dict:
    # The SVM needs the stripped text it was trained on (lowercase, no punctuation,
    # no stop words), NOT concatenate_email's output.
    print(email)
    text = preprocess_email(email, include_sender=SVM_INCLUDE_SENDER)
    print(f"Text : {text}")
 
    #if not text:
        #raise ValueError("Email contains no classifiable text.")
 
    model = _svm_model()
 
    if hasattr(model, "predict_proba"):
        # Calibrated model: a real probability for class 1 (Phishing).
        class_index = list(model.classes_).index(1)
        p_phishing = float(model.predict_proba([text])[0][class_index])
    else:
        # Plain LinearSVC has no probabilities. Squash the margin through a sigmoid.
        # 0.5 matches the model's own decision boundary, but the value is NOT a
        # calibrated probability, so do not read 0.9 as "90% sure".
        margin = float(model.decision_function([text])[0])
        margin = max(-30.0, min(30.0, margin))
        p_phishing = 1.0 / (1.0 + math.exp(-margin))
 
    is_phishing = p_phishing >= 0.5
 
    return {
        "email_id": email.id,
        "label": "Phishing" if is_phishing else "Legitimate",
        "score": p_phishing if is_phishing else 1.0 - p_phishing,
    }


def _finetuned_text(email: EmailRequest) -> str:
    """The layout the model was trained on: Subject + Email body, NO sender and
    no separate preview (concatenate_email would add both, which the model never
    saw). If the body is missing, the Gmail snippet stands in for it."""
    subject = clean_email_text(email.subject)
    body = (clean_email_text(email.body) or clean_email_text(email.snippet))[:5000]
 
    sections = []
    if subject:
        sections.append(f"Subject:\n{subject}")
    if body:
        sections.append(f"Email body:\n{body}")
    return "\n\n".join(sections)
 
 
def _phishing_probability(result) -> float:
    """P(Phishing) from the shapes a text-classification pipeline can return."""
    while isinstance(result, list) and result and isinstance(result[0], list):
        result = result[0]
    if isinstance(result, dict):
        result = [result]
 
    scores = {r["label"]: float(r["score"]) for r in result}
    for name in ("Phishing", "LABEL_1"):
        if name in scores:
            return scores[name]
    for name in ("Legitimate", "LABEL_0"):
        if name in scores:
            return 1.0 - scores[name]
    raise ValueError(f"Unexpected labels from the model: {list(scores)}")
 
 
def _classify_fine_tuned(email: EmailRequest) -> dict:
    text = _finetuned_text(email)
 
    if not text:
        raise ValueError("Email contains no classifiable text.")
 
    pipe = _fine_tuned_pipeline()
    try:
        result = pipe(text, truncation=True, max_length=FINETUNED_MAX_LEN, top_k=None)
    except TypeError:  # older transformers without top_k
        result = pipe(text, truncation=True, max_length=FINETUNED_MAX_LEN)
 
    p_phishing = _phishing_probability(result)
    is_phishing = p_phishing >= FINETUNED_THRESHOLD
 
    return {
        "email_id": email.id,
        "label": "Phishing" if is_phishing else "Legitimate",
        "score": p_phishing if is_phishing else 1.0 - p_phishing,
    }
 

def classify_email(email: EmailRequest, engine: str | None = None) -> dict:
    engine = engine or ENGINE
 
    if engine == "svm":
        return _classify_svm(email)
    if engine == "zeroshot":
        return _classify_zero_shot(email)
    if engine == "finetuned":
        return _classify_fine_tuned(email)
 
    raise ValueError(f"Unknown engine {engine!r}. Use 'svm' or 'zeroshot'.")