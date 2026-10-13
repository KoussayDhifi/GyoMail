from pydantic import BaseModel

class Sender(BaseModel):
    name: str
    email: str