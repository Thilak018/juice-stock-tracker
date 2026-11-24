"""Cue N Console Arena - Juice Stock & Sales Tracker (Flask + MongoDB backend)."""
import csv
import io
import os
import re
import secrets
import time
from datetime import date as date_cls, datetime
from functools import wraps

from bson import ObjectId
from bson.errors import InvalidId
from flask import Flask, jsonify, request, send_from_directory, session, redirect, Response
from pymongo import ASCENDING, MongoClient
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

MONGO_URI = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017")
MONGO_DB = os.environ.get("MONGO_DB", "juice_tracker")


def load_secret_key():
    """Use SECRET_KEY from env, otherwise create one once and keep it in .secret_key."""
    key = os.environ.get("SECRET_KEY")
    if key:
        
        return key
    path = os.path.join(BASE_DIR, ".secret_key")
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(path, "w") as f:
        f.write(key)
    return key


app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    PERMANENT_SESSION_LIFETIME=8 * 60 * 60,
    MAX_CONTENT_LENGTH=64 * 1024,
)

client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client[MONGO_DB]
users, products, sales, purchases = db.users, db.products, db.sales, db.purchases

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


# --------------------------------------------------------------------------
# Errors / helpers
# --------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


@app.errorhandler(ApiError)
def handle_api_error(e):
    return jsonify(error=e.message), e.status


@app.errorhandler(Exception)
def handle_unexpected_exception(e):
    if isinstance(e, ApiError):
        return jsonify(error=e.message), e.status
    err_str = str(e)
    if "ServerSelectionTimeoutError" in type(e).__name__ or "timeout" in err_str.lower():
        return jsonify(error="Cannot connect to Database. Please verify MONGO_URI in Render and Atlas Network Access (0.0.0.0/0)."), 500
    if request.path.startswith("/api/"):
        return jsonify(error=f"Server error: {err_str}"), 500
    return f"Server error: {err_str}", 500


@app.errorhandler(404)
def handle_404(_):
    if request.path.startswith("/api/"):
        return jsonify(error="Unknown API endpoint"), 404
    return "Not found", 404


@app.errorhandler(413)
def handle_413(_):
    return jsonify(error="Request too large"), 413


@app.errorhandler(405)
def handle_405(_):
    return jsonify(error="Method not allowed"), 405


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Cache-Control"] = "no-store"
    return resp


def body_json():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Invalid JSON body")
    return data


def s(data, key):
    v = data.get(key)
    return "" if v is None else str(v).strip()


def number(data, key, label):
    v = data.get(key)
    if isinstance(v, bool):
        raise ApiError(f"{label} must be a number")
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise ApiError(f"{label} must be a number")
    if n != n or n in (float("inf"), float("-inf")):
        raise ApiError(f"{label} must be a number")
    return n


def whole(data, key, label):
    n = number(data, key, label)
    if n != int(n) or n > 1_000_000:
        raise ApiError(f"{label} must be a whole number")
    return int(n)


def valid_date(value):
    if not value or not DATE_RE.match(value):
        raise ApiError("Invalid date (use YYYY-MM-DD)")
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        raise ApiError("Invalid date")
    return value


def public(doc):
    out = {k: v for k, v in doc.items() if k not in ("_id", "createdAt")}
    out["id"] = str(doc["_id"])
    return out


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
MAX_FAILS, LOCK_SECONDS = 5, 60
failed_logins = {}  # ip -> [count, first_fail_time]


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if "user" not in session:
            raise ApiError("Please log in", 401)
        return fn(*args, **kwargs)

    return wrapper


@app.post("/api/login")
def api_login():
    ip = request.remote_addr or "?"
    rec = failed_logins.get(ip)
    if rec and time.time() - rec[1] > LOCK_SECONDS:
        failed_logins.pop(ip, None)
        rec = None
    if rec and rec[0] >= MAX_FAILS:
        raise ApiError("Too many failed attempts. Try again in a minute.", 429)

    data = body_json()
    username = s(data, "username")
    password = str(data.get("password") or "")
    user = users.find_one({"username": username}) if username else None
    if not user or not check_password_hash(user["hash"], password):
        if rec:
            rec[0] += 1
        else:
            failed_logins[ip] = [1, time.time()]
        raise ApiError("Invalid username or password", 401)

    failed_logins.pop(ip, None)
    session.clear()
    session.permanent = True
    session["user"] = user["username"]
    return jsonify(username=user["username"], name=user.get("name", user["username"]))


@app.get("/api/health")
def api_health():
    try:
        client.admin.command("ping")
        u_count = users.count_documents({})
        return jsonify(
            status="ok",
            mongo_connected=True,
            database=MONGO_DB,
            users_count=u_count,
            mongo_uri_configured="MONGO_URI" in os.environ
        )
    except Exception as e:
        return jsonify(
            status="error",
            mongo_connected=False,
            error=str(e),
            mongo_uri_configured="MONGO_URI" in os.environ
        ), 500


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
@login_required
def api_me():
    user = users.find_one({"username": session["user"]})
    return jsonify(username=session["user"], name=(user or {}).get("name", session["user"]))


# --------------------------------------------------------------------------
# Stock logic
# --------------------------------------------------------------------------
def totals_by_brand(collection, day):
    """brand -> (qty before `day`, qty on `day`)."""
    pipeline = [{
        "$group": {
            "_id": "$brand",
            "before": {"$sum": {"$cond": [{"$lt": ["$date", day]}, "$qty", 0]}},
            "today": {"$sum": {"$cond": [{"$eq": ["$date", day]}, "$qty", 0]}},
        }
    }]
    return {r["_id"]: (r["before"], r["today"]) for r in collection.aggregate(pipeline)}


def stock_for(day):
    bought = totals_by_brand(purchases, day)
    sold = totals_by_brand(sales, day)
    rows = []
    for p in products.find().sort("name", ASCENDING):
        name = p["name"]
        b_before, b_today = bought.get(name, (0, 0))
        s_before, s_today = sold.get(name, (0, 0))
        opening = p.get("initialStock", 0) + b_before - s_before
        closing = opening + b_today - s_today
        low = p.get("lowStock", 10)
        status = "OUT" if closing <= 0 else ("LOW" if closing <= low else "OK")
        rows.append({
            "brand": name, "rate": p.get("rate", 0), "cost": p.get("cost", 0), "lowStock": low,
            "opening": opening, "purchased": b_today, "sold": s_today,
            "closing": closing, "status": status,
        })
    return rows


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
def pending_summary():
    """All unpaid sales (any date) grouped by customer."""
    groups = {}
    total, count = 0.0, 0
    for d in sales.find({"status": "Pending"}).sort([("date", ASCENDING), ("time", ASCENDING)]):
        key = d["customer"].strip().lower()
        g = groups.setdefault(key, {"customer": d["customer"], "amount": 0.0, "count": 0,
                                    "bottles": 0, "since": d["date"], "ids": []})
        g["amount"] += d["amount"]
        g["count"] += 1
        g["bottles"] += d["qty"]
        g["ids"].append(str(d["_id"]))
        total += d["amount"]
        count += 1
    customers = sorted(groups.values(), key=lambda g: -g["amount"])
    for g in customers:
        g["amount"] = round(g["amount"], 2)
    return {"total": round(total, 2), "count": count, "customers": customers}


@app.get("/api/dashboard")
@login_required
def api_dashboard():
    day = valid_date(request.args.get("date") or date_cls.today().isoformat())
    stock = stock_for(day)

    sale_docs = list(sales.find({"date": day}).sort([("time", ASCENDING), ("createdAt", ASCENDING)]))
    bottles = 0
    total = cash = upi = profit = day_pending = 0.0
    for d in sale_docs:
        d.setdefault("status", "Paid")  # sales saved before this feature were all paid
        bottles += d["qty"]
        profit += d["amount"] - d["qty"] * d.get("cost", 0)
        if d["status"] == "Pending":
            day_pending += d["amount"]
            continue
        total += d["amount"]
        if d["payment"] == "Cash":
            cash += d["amount"]
        else:
            upi += d["amount"]
    # money received on this date for sales made on earlier dates
    recovered = sum(x["amount"] for x in sales.find({"paidDate": day, "date": {"$ne": day}}))

    alerts = []
    for st in stock:
        c = st["closing"]
        if st["status"] == "OUT":
            alerts.append({"type": "danger", "brand": st["brand"], "label": "Out of Stock", "message": f"{st['brand']} is out of stock"})
        elif st["status"] == "LOW":
            alerts.append({"type": "danger", "brand": st["brand"], "label": "Low Stock",
                           "message": f"{st['brand']} stock is low (Only {c} bottle{'' if c == 1 else 's'} left)"})
        else:
            alerts.append({"type": "ok", "brand": st["brand"], "label": "OK", "message": f"{st['brand']} stock OK ({c} bottles)"})
    alerts.sort(key=lambda a: a["type"] != "danger")

    return jsonify(
        date=day,
        summary={
            "totalBottles": bottles, "totalCollection": round(total, 2),
            "cash": round(cash, 2), "upi": round(upi, 2),
            "opening": sum(x["opening"] for x in stock), "closing": sum(x["closing"] for x in stock),
            "profit": round(profit, 2),
            "pendingToday": round(day_pending, 2), "recovered": round(recovered, 2),
        },
        sales=[public(d) for d in sale_docs],
        stock=stock,
        alerts=alerts,
        pending=pending_summary(),
    )


def parse_sale(data, exclude_id=None):
    """Validate sale input and return the fields to store. `exclude_id` = sale being edited."""
    day = valid_date(s(data, "date"))
    t = s(data, "time")
    if not TIME_RE.match(t):
        raise ApiError("Invalid time (use HH:MM)")
    customer = s(data, "customer")
    if not customer or len(customer) > 60:
        raise ApiError("Customer name is required (max 60 characters)")
    brand = s(data, "brand")
    qty = whole(data, "qty", "Quantity")
    if qty < 1:
        raise ApiError("Quantity must be at least 1")
    rate = number(data, "rate", "Rate")
    if rate < 0:
        raise ApiError("Rate cannot be negative")
    status = s(data, "status") or "Paid"
    if status not in ("Paid", "Pending"):
        raise ApiError("Status must be Paid or Pending")
    payment = s(data, "payment")
    if status == "Paid" and payment not in ("Cash", "UPI"):
        raise ApiError("Payment mode must be Cash or UPI")
    if status == "Pending":
        payment = ""  # chosen when the money is collected
    remarks = s(data, "remarks")
    if len(remarks) > 120:
        raise ApiError("Remarks too long (max 120 characters)")

    prod = products.find_one({"name": brand})
    if not prod:
        raise ApiError("Unknown juice brand")

    old = None
    extra = 0  # bottles of this very sale already counted as sold
    if exclude_id is not None:
        old = sales.find_one({"_id": exclude_id})
        if not old:
            raise ApiError("Sale not found", 404)
        if old["date"] == day and old["brand"] == brand:
            extra = old["qty"]
    for st in stock_for(day):
        if st["brand"] == brand and qty > st["closing"] + extra:
            raise ApiError(f"Only {st['closing'] + extra} bottle(s) of {brand} in stock on this date")

    cost = old["cost"] if old and old["brand"] == brand else prod.get("cost", 0)
    return {
        "date": day, "time": t, "customer": customer, "brand": brand, "qty": qty,
        "rate": rate, "amount": round(qty * rate, 2), "payment": payment,
        "status": status, "cost": cost, "remarks": remarks,
    }


@app.post("/api/sales")
@login_required
def api_add_sale():
    doc = parse_sale(body_json())
    doc["createdAt"] = time.time()
    if doc["status"] == "Paid":
        doc["paidDate"] = doc["date"]
    doc["_id"] = sales.insert_one(doc).inserted_id
    return jsonify(public(doc)), 201


@app.put("/api/sales/<sale_id>")
@login_required
def api_edit_sale(sale_id):
    try:
        oid = ObjectId(sale_id)
    except (InvalidId, TypeError):
        raise ApiError("Invalid sale id")
    fields = parse_sale(body_json(), oid)
    old = sales.find_one({"_id": oid})
    ops = {"$set": fields}
    if fields["status"] == "Paid":
        if old.get("status", "Paid") == "Pending":
            fields["paidDate"] = date_cls.today().isoformat()  # settled now
        elif "paidDate" not in old:
            fields["paidDate"] = fields["date"]
    else:
        ops["$unset"] = {"paidDate": ""}
    sales.update_one({"_id": oid}, ops)
    return jsonify(ok=True)


@app.post("/api/sales/pay")
@login_required
def api_pay_sales():
    """Mark one or more pending sales as paid (Cash or UPI)."""
    data = body_json()
    payment = s(data, "payment")
    if payment not in ("Cash", "UPI"):
        raise ApiError("Payment mode must be Cash or UPI")
    ids = data.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > 500:
        raise ApiError("No sales selected")
    try:
        oids = [ObjectId(str(i)) for i in ids]
    except (InvalidId, TypeError):
        raise ApiError("Invalid sale id")
    res = sales.update_many(
        {"_id": {"$in": oids}, "status": "Pending"},
        {"$set": {"status": "Paid", "payment": payment, "paidDate": date_cls.today().isoformat()}})
    if res.modified_count == 0:
        raise ApiError("Nothing to collect (already paid?)", 404)
    return jsonify(updated=res.modified_count)


@app.get("/api/export-csv")
@login_required
def api_export_csv():
    day = valid_date(request.args.get("date") or date_cls.today().isoformat())
    sale_docs = list(sales.find({"date": day}).sort([("time", ASCENDING), ("createdAt", ASCENDING)]))
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["#", "Date", "Time", "Customer", "Brand", "Qty", "Rate (INR)", "Total Amount (INR)", "Payment Mode", "Paid Amount (INR)", "Pending Amount (INR)", "Remarks"])
    
    tot_qty = 0
    tot_amt = 0.0
    tot_paid = 0.0
    tot_pend = 0.0
    
    for i, s in enumerate(sale_docs, 1):
        is_pending = s.get("status") == "Pending"
        paid_amt = 0.0 if is_pending else s["amount"]
        pend_amt = s["amount"] if is_pending else 0.0
        
        tot_qty += s["qty"]
        tot_amt += s["amount"]
        tot_paid += paid_amt
        tot_pend += pend_amt
        
        writer.writerow([
            i, s["date"], s["time"], s["customer"], s["brand"], s["qty"], s["rate"], s["amount"],
            s.get("payment", "") or "-", paid_amt, pend_amt, s.get("remarks", "") or "-"
        ])
        
    writer.writerow([])
    writer.writerow(["TOTALS", day, "", "", "", tot_qty, "", tot_amt, "", tot_paid, tot_pend, ""])
    
    csv_data = "\ufeff" + output.getvalue()
    return Response(
        csv_data,
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=juice-sales-{day}.csv"}
    )


@app.delete("/api/sales/<sale_id>")
@login_required
def api_delete_sale(sale_id):
    try:
        oid = ObjectId(sale_id)
    except (InvalidId, TypeError):
        raise ApiError("Invalid sale id")
    if sales.delete_one({"_id": oid}).deleted_count == 0:
        raise ApiError("Sale not found", 404)
    return jsonify(ok=True)


@app.post("/api/purchases")
@login_required
def api_add_purchase():
    data = body_json()
    day = valid_date(s(data, "date"))
    brand = s(data, "brand")
    qty = whole(data, "qty", "Quantity")
    if qty < 1:
        raise ApiError("Quantity must be at least 1")
    if not products.find_one({"name": brand}):
        raise ApiError("Unknown juice brand")
    purchases.insert_one({"date": day, "brand": brand, "qty": qty, "createdAt": time.time()})
    return jsonify(ok=True), 201


@app.get("/api/products")
@login_required
def api_products():
    return jsonify(products=[public(p) for p in products.find().sort("name", ASCENDING)])


@app.post("/api/products")
@login_required
def api_save_product():
    data = body_json()
    name = s(data, "name")
    if not name or len(name) > 40:
        raise ApiError("Brand name is required (max 40 characters)")
    rate = number(data, "rate", "Rate")
    cost = number(data, "cost", "Cost price")
    low = whole(data, "lowStock", "Low-stock level")
    if rate < 0 or cost < 0 or low < 0:
        raise ApiError("Values cannot be negative")
    if products.find_one({"name": name}):
        products.update_one({"name": name}, {"$set": {"rate": rate, "cost": cost, "lowStock": low}})
    else:
        initial = whole(data, "initialStock", "Opening stock") if "initialStock" in data else 0
        if initial < 0:
            raise ApiError("Opening stock cannot be negative")
        products.insert_one({"name": name, "rate": rate, "cost": cost, "lowStock": low, "initialStock": initial})
    return jsonify(ok=True), 201


@app.delete("/api/products/<name>")
@login_required
def api_delete_product(name):
    name = name.strip()
    prod = products.find_one({"name": name})
    if not prod:
        raise ApiError("Brand not found", 404)
    products.delete_one({"name": name})
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# Pages (frontend)
# --------------------------------------------------------------------------
@app.get("/")
def page_index():
    if "user" not in session:
        return redirect("/login")
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.get("/login")
@app.get("/login.html")
def page_login():
    if "user" in session:
        return redirect("/")
    return send_from_directory(FRONTEND_DIR, "login.html")


@app.get("/css/<path:name>")
def assets_css(name):
    return send_from_directory(os.path.join(FRONTEND_DIR, "css"), name)


@app.get("/js/<path:name>")
def assets_js(name):
    return send_from_directory(os.path.join(FRONTEND_DIR, "js"), name)


# --------------------------------------------------------------------------
# Seed data
# --------------------------------------------------------------------------
def seed():
    users.create_index("username", unique=True)
    products.create_index("name", unique=True)
    sales.create_index("date")
    purchases.create_index("date")

    admin_user = (os.environ.get("ADMIN_USERNAME") or "admin").strip()
    admin_pw = os.environ.get("ADMIN_PASSWORD") or "admin123"

    existing = users.find_one({"username": admin_user})
    if not existing:
        users.insert_one({"username": admin_user, "name": "Arena Admin", "hash": generate_password_hash(admin_pw)})
        print(f"Created admin user '{admin_user}'.")
    elif os.environ.get("ADMIN_PASSWORD"):
        users.update_one({"username": admin_user}, {"$set": {"hash": generate_password_hash(admin_pw)}})
        print(f"Updated password for user '{admin_user}'.")

    if products.count_documents({}) == 0:
        products.insert_many([
            {"name": "Maaza", "rate": 80, "cost": 55, "lowStock": 10, "initialStock": 20},
            {"name": "Slice", "rate": 80, "cost": 55, "lowStock": 10, "initialStock": 5},
            {"name": "Frooti", "rate": 90, "cost": 62, "lowStock": 10, "initialStock": 15},
            {"name": "Real Apple", "rate": 80, "cost": 55, "lowStock": 10, "initialStock": 10},
        ])
        if os.environ.get("SEED_DEMO", "true").lower() != "false":
            seed_demo()


def seed_demo():
    today = date_cls.today().isoformat()
    rows = [
        ("09:15", "Rahul Kumar", "Maaza", 2, 80, "UPI", 55),
        ("10:30", "Priya Sharma", "Slice", 3, 80, "Cash", 55),
        ("11:45", "Manoj Shetty", "Frooti", 2, 90, "UPI", 62),
        ("13:20", "Sneha Nair", "Real Apple", 1, 80, "Cash", 55),
        ("15:10", "Rohan D'Souza", "Maaza", 4, 80, "UPI", 55),
        ("17:00", "Akash Rao", "Slice", 5, 80, "Cash", 55),
        ("18:30", "Divya K.", "Frooti", 3, 90, "UPI", 62),
    ]
    for i, (t, cust, brand, qty, rate, pay, cost) in enumerate(rows):
        sales.insert_one({"date": today, "time": t, "customer": cust, "brand": brand, "qty": qty,
                          "rate": rate, "amount": qty * rate, "payment": pay, "cost": cost,
                          "remarks": "", "createdAt": time.time() + i})
    for brand, qty in (("Maaza", 10), ("Slice", 10), ("Frooti", 10), ("Real Apple", 5)):
        purchases.insert_one({"date": today, "brand": brand, "qty": qty, "createdAt": time.time()})


def init_db():
    try:
        client.admin.command("ping")  # verify connection
        seed()
    except Exception as e:
        print(f"Database initialization notice: {e}")


# Initialize database when app is loaded (works with Gunicorn and direct python)
init_db()


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    print(f"Juice Stock & Sales Tracker running at http://{host}:{port}/")
    app.run(host=host, port=port, debug=False)
