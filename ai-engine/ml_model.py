import yfinance as yf
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression

df = yf.download("NIFTYBEES.NS", period="1mo", interval="5m")

df['EMA20'] = df['Close'].ewm(span=20).mean()
df['EMA50'] = df['Close'].ewm(span=50).mean()

df = df.dropna()

df['target'] = (df['Close'].shift(-1) > df['Close']).astype(int)

X = df[['EMA20', 'EMA50']]
y = df['target']

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)

model = LogisticRegression()
model.fit(X_train, y_train)

print("Accuracy:", model.score(X_test, y_test))