from pydantic import BaseModel
from .sender import Sender

class EmailRequest(BaseModel):
    id : str

    sender : Sender

    subject : str

    snippet : str

    timestamp : str

    body : str | None = None

class EmailBatch(BaseModel):
    emails : list[EmailRequest]
