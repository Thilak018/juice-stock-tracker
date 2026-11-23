# Cue N Console Arena – Juice Stock & Sales Tracker

Website for tracking juice stock and sales.

| Layer     | Tech |
|-----------|------|
| Frontend  | HTML5, CSS3, Bootstrap 5, JavaScript (DOM manipulation, `fetch`) |
| Backend   | Python 3 + Flask |
| Database  | MongoDB (`juice_tracker` DB: `users`, `products`, `sales`, `purchases`) |
| Pages     | Login page (`/login`) and dashboard (`/`, requires login) |

## Run

1. Make sure MongoDB is running on `mongodb://127.0.0.1:27017`.
2. Install dependencies: `pip install -r requirements.txt`
3. Start: `python app.py`
4. Open http://127.0.0.1:5000 and log in with **admin / admin123**.

On the first run the app creates the `admin` user, 4 juice brands and demo sales for today
(set `SEED_DEMO=false` to skip the demo sales, `ADMIN_PASSWORD=...` to choose the admin password).

Environment variables: `MONGO_URI`, `MONGO_DB`, `HOST`, `PORT`, `SECRET_KEY`, `ADMIN_PASSWORD`, `SEED_DEMO`.

## Notes
- Opening stock of a day = initial stock + all purchases − all sales of earlier days.
- Profit = Σ (rate − cost price) × qty, using the cost price recorded when the sale was made.
- A brand is flagged **Low** when closing stock ≤ its low-stock level (default 10).
- Each sale is **Paid** (Cash/UPI) or **Pending** (pay later). Only paid sales count in *Total Collection* and the
  Cash/UPI pie; pending dues (across all dates) are grouped per customer in **Pending Payments**, where **Collect**
  marks them paid via Cash or UPI. Profit counts every sale, paid or not.
