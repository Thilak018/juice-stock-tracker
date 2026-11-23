(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------ */
  var $ = function (id) { return document.getElementById(id); };

  // Create a DOM element: el('td', {cls:'x', text:'hi', attrs:{title:'t'}, on:{click:fn}}, child1, child2)
  function el(tag, opts) {
    var node = document.createElement(tag);
    opts = opts || {};
    if (opts.cls) node.className = opts.cls;
    if (opts.text !== undefined) node.textContent = opts.text; // textContent => safe against XSS
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { node.setAttribute(k, opts.attrs[k]); });
    if (opts.on) Object.keys(opts.on).forEach(function (k) { node.addEventListener(k, opts.on[k]); });
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child !== null && child !== undefined && child !== false) {
        if (typeof child === 'string' || typeof child === 'number') {
          node.appendChild(document.createTextNode(child));
        } else if (child.nodeType) {
          node.appendChild(child);
        }
      }
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  var money = function (n) { return '₹ ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
  var moneyTight = function (n) { return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
  var pad2 = function (n) { return String(n).padStart(2, '0'); };

  function isoOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayISO() { return isoOf(new Date()); }
  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return isoOf(d);
  }
  function displayDate(iso) { var p = iso.split('-'); return p[2] + '-' + p[1] + '-' + p[0]; }

  function time12(hhmm) {
    var parts = hhmm.split(':');
    var h = parseInt(parts[0], 10);
    var suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return pad2(h) + ':' + parts[1] + ' ' + suffix;
  }
  function nowHHMM() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  function api(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', credentials: 'same-origin', headers: {} };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401) { window.location.href = '/login'; throw new Error('Session expired'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
      });
    });
  }

  function toast(message, kind) {
    var t = el('div', { cls: 'toast align-items-center text-bg-' + (kind || 'success') + ' border-0', attrs: { role: 'status' } },
      el('div', { cls: 'd-flex' },
        el('div', { cls: 'toast-body', text: message }),
        el('button', { cls: 'btn-close btn-close-white me-2 m-auto', attrs: { type: 'button', 'data-bs-dismiss': 'toast', 'aria-label': 'Close' } })));
    $('toastBox').appendChild(t);
    t.addEventListener('hidden.bs.toast', function () { t.remove(); });
    new bootstrap.Toast(t, { delay: 3000 }).show();
  }

  function showErr(box, msg) { box.textContent = msg; box.classList.remove('d-none'); }
  function hideErr(box) { box.classList.add('d-none'); }

  /* ------------------------------------------------------------------
   * State
   * ------------------------------------------------------------------ */
  var state = {
    date: todayISO(),
    stock: [],
    products: [],
    sales: [],
    summary: null,
    filter: 'All',   // All | Cash | UPI
    query: '',
    editId: null,    // id of the sale being edited (null => adding)
    editDate: null,
    newIds: {}       // ids to animate as "new"
  };

  /* ------------------------------------------------------------------
   * Rendering (all via DOM APIs)
   * ------------------------------------------------------------------ */
  function setValue(node, text) {
    if (node.textContent !== String(text)) {
      node.textContent = text;
      node.classList.remove('bump');
      void node.offsetWidth; // restart CSS animation
      node.classList.add('bump');
    }
  }

  function renderSummary(s, date) {
    s = s || {};
    setValue($('cTotalSales'), s.totalBottles || 0);
    setValue($('cCollection'), money(s.totalCollection || 0));
    $('cSplit').textContent = 'Cash: ' + moneyTight(s.cash || 0) + ' | UPI: ' + moneyTight(s.upi || 0);
    setValue($('cOpening'), s.opening || 0);
    setValue($('cClosing'), s.closing || 0);
    setValue($('cProfit'), money(s.profit || 0));
    if (date) {
      var d = new Date(date + 'T00:00:00');
      $('weekday').textContent = '(' + d.toLocaleDateString('en-IN', { weekday: 'short' }) + ')';
      $('dateInput').value = date;
    }
  }

  function visibleSales() {
    var q = state.query.trim().toLowerCase();
    return state.sales.filter(function (s) {
      if (state.filter === 'Pending') { if (s.status !== 'Pending') return false; }
      else if (state.filter === 'Paid') { if (s.status === 'Pending') return false; }
      else if (state.filter !== 'All' && s.payment !== state.filter) return false;
      if (!q) return true;
      return (s.customer + ' ' + s.brand + ' ' + (s.remarks || '')).toLowerCase().indexOf(q) !== -1;
    });
  }

  function statusBadge(sale) {
    var pending = sale.status === 'Pending';
    return el('span', { cls: 'status-pill ' + (pending ? 'status-out' : 'status-ok'), text: pending ? '⏳ Pending' : '✔ Paid' });
  }

  function payButton(sale) {
    return el('button', {
      cls: 'btn-act btn-pay', text: '💰', attrs: { title: 'Collect payment', 'aria-label': 'Collect payment from ' + sale.customer },
      on: { click: function () { openPayModal([sale.id], sale.customer, sale.amount); } }
    });
  }

  function renderSales() {
    var list = visibleSales();
    var filtered = state.filter !== 'All' || state.query.trim() !== '';
    var body = $('salesBody');
    clear(body);

    if (!list.length) {
      var msg = filtered ? 'No sales match your filter.' : 'No sales recorded for this date. Click “Add Sale” or use Quick Sell.';
      body.appendChild(el('tr', { cls: 'empty-row' }, el('td', { text: msg, attrs: { colspan: '12' } })));
    }

    var qty = 0, amount = 0, cash = 0, upi = 0, pend = 0;
    list.forEach(function (sale, i) {
      qty += sale.qty; amount += sale.amount;
      var isPending = sale.status === 'Pending';
      if (isPending) pend += sale.amount;
      else if (sale.payment === 'Cash') cash += sale.amount;
      else upi += sale.amount;

      var edit = el('button', {
        cls: 'btn-act btn-edit', text: '✏', attrs: { title: 'Edit sale', 'aria-label': 'Edit sale ' + (i + 1) },
        on: { click: function () { openSaleModal(sale); } }
      });
      var del = el('button', {
        cls: 'btn-act btn-del', text: '🗑', attrs: { title: 'Delete sale', 'aria-label': 'Delete sale ' + (i + 1) },
        on: { click: function () { deleteSale(sale); } }
      });

      var paidCell = isPending
        ? el('td', { cls: 'text-end text-muted-soft', text: '–' })
        : el('td', { cls: 'text-end col-paid', text: Number(sale.amount).toLocaleString('en-IN') });

      var pendingCell = isPending
        ? el('td', { cls: 'text-end' },
            el('button', {
              cls: 'btn btn-sm btn-outline-danger btn-pending-pay btn-press py-0 px-2',
              text: '₹ ' + Number(sale.amount).toLocaleString('en-IN') + ' 💰',
              attrs: { title: 'Click to collect payment from ' + sale.customer },
              on: { click: function () { openPayModal([sale.id], sale.customer, sale.amount); } }
            })
          )
        : el('td', { cls: 'text-end text-muted-soft', text: '–' });

      var tr = el('tr', { cls: (state.newIds[sale.id] ? 'row-new ' : '') + (isPending ? 'row-pending' : '') },
        el('td', { text: i + 1 }),
        el('td', { text: time12(sale.time) }),
        el('td', { text: sale.customer }),
        el('td', { text: sale.brand }),
        el('td', { cls: 'text-end', text: sale.qty }),
        el('td', { cls: 'text-end', text: Number(sale.rate).toLocaleString('en-IN') }),
        el('td', { cls: 'text-end fw-bold', text: Number(sale.amount).toLocaleString('en-IN') }),
        el('td', { cls: 'text-center', text: sale.payment || '–' }),
        paidCell,
        pendingCell,
        el('td', { text: sale.remarks || '–' }),
        el('td', { cls: 'text-nowrap' }, edit, del));
      body.appendChild(tr);
    });
    state.newIds = {};

    $('fLabel').textContent = filtered ? 'Total (filtered)' : 'Total';
    $('fQty').textContent = qty;
    $('fAmount').textContent = money(amount);
    $('fSplit').textContent = 'Cash: ' + moneyTight(cash) + ' | UPI: ' + moneyTight(upi);
    $('fPaid').textContent = money(amount - pend);
    $('fPending').textContent = money(pend);

    $('filterInfo').textContent = filtered
      ? 'Showing ' + list.length + ' of ' + state.sales.length + ' sales'
      : state.sales.length + ' sale' + (state.sales.length === 1 ? '' : 's');
    $('btnClearFilter').classList.toggle('d-none', !filtered);

    // payment filter button styles
    Array.prototype.forEach.call($('payFilter').querySelectorAll('button'), function (b) {
      var active = b.getAttribute('data-filter') === state.filter;
      var f = b.getAttribute('data-filter');
      var outline = f === 'Cash' ? 'btn-outline-warning' : (f === 'UPI' ? 'btn-outline-primary' : (f === 'Paid' ? 'btn-outline-success' : (f === 'Pending' ? 'btn-outline-danger' : 'btn-outline-light')));
      var solid = f === 'Cash' ? 'btn-warning' : (f === 'UPI' ? 'btn-primary' : (f === 'Paid' ? 'btn-success' : (f === 'Pending' ? 'btn-danger' : 'btn-light')));
      b.className = 'btn btn-sm btn-press ' + (active ? solid : outline);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function renderStock(list) {
    var body = $('stockBody');
    clear(body);
    list.forEach(function (st) {
      var cls = st.status === 'OK' ? 'status-ok' : (st.status === 'LOW' ? 'status-low' : 'status-out');
      var label = st.status === 'OK' ? '✔ OK' : (st.status === 'LOW' ? '⚠ Low' : '✖ Out');

      // Visual progress ratio based on opening + purchased vs closing
      var maxRef = Math.max(st.opening + st.purchased, st.closing, 1);
      var pct = Math.min(100, Math.max(0, Math.round((st.closing / maxRef) * 100)));
      var barColor = st.status === 'OK' ? '#10b981' : (st.status === 'LOW' ? '#f59e0b' : '#ef4444');

      // Brand cell with glowing dot and crisp label
      var brandDot = el('span', { cls: 'stock-brand-dot' });
      var brandName = el('span', { cls: 'stock-brand-name', text: st.brand });
      var brandCell = el('td', { cls: 'text-start text-nowrap' }, brandDot, brandName);

      // Closing cell with number and mini progress bar
      var closingNum = el('div', { cls: 'stock-closing-num', text: st.closing });
      var miniBar = el('div', { cls: 'stock-mini-bar-track' },
        el('div', { cls: 'stock-mini-bar-fill', attrs: { style: 'width:' + pct + '%; background:' + barColor } })
      );
      var closingCell = el('td', { cls: 'text-center' }, closingNum, miniBar);

      var tr = el('tr', {
        cls: 'stock-row',
        attrs: { title: 'Click to filter sales by ' + st.brand },
        on: {
          click: function () {
            $('searchBox').value = st.brand;
            state.query = st.brand;
            renderSales();
            toast('Filtered sales table for ' + st.brand, 'info');
            $('salesTable').scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      },
        brandCell,
        el('td', { cls: 'text-center stock-num text-white', text: st.opening }),
        el('td', { cls: 'text-center stock-num text-white', text: st.purchased }),
        el('td', { cls: 'text-center stock-num text-white', text: st.sold }),
        closingCell,
        el('td', { cls: 'text-center' }, el('span', { cls: 'status-pill ' + cls, text: label }))
      );
      body.appendChild(tr);
    });
    if (!list.length) body.appendChild(el('tr', {}, el('td', { text: 'No brands yet', attrs: { colspan: '6' } })));
  }

  function renderPayment(s) {
    s = s || {};
    var cash = s.cash || 0;
    var upi = s.upi || 0;
    var total = cash + upi;
    var pie = $('pie');
    var upiPct = total ? Math.round((upi / total) * 100) : 0;
    var cashPct = total ? 100 - upiPct : 0;
    pie.style.background = total
      ? 'conic-gradient(#1e90ff 0 ' + upiPct + '%, #ff8c00 ' + upiPct + '% 100%)'
      : '#25335c';
    placeLabel($('pieUpi'), upiPct, 0, upiPct);
    placeLabel($('pieCash'), cashPct, upiPct, 100);
    $('lgUpi').textContent = moneyTight(upi);
    $('lgCash').textContent = moneyTight(cash);
  }

  function placeLabel(node, pct, from, to) {
    if (pct < 6) { node.textContent = ''; return; }
    node.textContent = pct + '%';
    var mid = ((from + to) / 2) / 100 * 2 * Math.PI;
    var r = 40;
    node.style.left = (50 + r * Math.sin(mid) - 8) + '%';
    node.style.top = (50 - r * Math.cos(mid) - 6) + '%';
  }

  function renderAlerts(list) {
    var box = $('alertsBox');
    clear(box);
    list.forEach(function (a) {
      var restock = a.type === 'danger' && a.brand
        ? el('button', {
            cls: 'btn btn-sm btn-warning btn-restock btn-press', text: '＋ Restock',
            attrs: { title: 'Restock ' + a.brand },
            on: { click: function () { openRestockModal(a.brand); } }
          })
        : null;
      box.appendChild(el('div', { cls: 'alert-item ' + a.type },
        el('span', { text: (a.type === 'danger' ? '⚠ ' : 'ℹ ') + a.message }),
        el('span', { cls: 'd-flex align-items-center gap-2' }, restock, el('span', { cls: 'alert-badge', text: a.label }))));
    });
    if (!list.length) box.appendChild(el('div', { cls: 'text-muted-soft', text: 'No alerts.' }));
  }

  function renderPending(p, s) {
    p = p || { total: 0, count: 0, customers: [] };
    p.customers = p.customers || [];
    s = s || {};
    setValue($('cPending'), money(p.total || 0));
    $('cPendingSub').textContent = p.count
      ? p.count + ' sale' + (p.count === 1 ? '' : 's') + ' • ' + p.customers.length + ' customer' + (p.customers.length === 1 ? '' : 's')
      : 'All clear 🎉';
    $('pendingBadge').textContent = p.customers.length;
    $('recoveredNote').textContent = s.recovered
      ? 'Collected on this date from older dues: ' + money(s.recovered) : '';
    var body = $('pendingBody');
    clear(body);
    if (!p.customers.length) {
      body.appendChild(el('tr', { cls: 'empty-row' }, el('td', { text: 'No pending payments. 🎉', attrs: { colspan: '6' } })));
      return;
    }
    p.customers.forEach(function (c) {
      body.appendChild(el('tr', { cls: 'pending-row' },
        el('td', { cls: 'fw-bold text-white', text: c.customer }),
        el('td', { cls: 'text-center fw-semibold text-white', text: c.count }),
        el('td', { cls: 'text-center fw-semibold text-white', text: c.bottles }),
        el('td', { cls: 'fw-semibold text-white', text: displayDate(c.since) }),
        el('td', { cls: 'text-end cust-due fw-bold text-white', text: Number(c.amount).toLocaleString('en-IN') }),
        el('td', { cls: 'text-end' }, el('button', {
          cls: 'btn btn-sm btn-success btn-press fw-bold', text: '💰 Collect', attrs: { type: 'button' },
          on: { click: function () { openPayModal(c.ids, c.customer + ' (' + c.count + ' sale' + (c.count === 1 ? '' : 's') + ')', c.amount); } }
        }))));
    });
  }

  // Quick-sell cards: one per brand with UPI / Cash / Later buttons
  function renderQuickSell(stock) {
    var box = $('quickSell');
    clear(box);
    if (!stock.length) {
      box.appendChild(el('div', { cls: 'col-12 text-muted-soft', text: 'Add a juice brand to start selling.' }));
      return;
    }
    stock.forEach(function (st) {
      var out = st.closing <= 0;
      var upiBtn = el('button', {
        cls: 'btn btn-sm btn-primary flex-fill btn-press', text: 'UPI', attrs: { type: 'button', title: 'Quick sell with UPI' },
        on: { click: function () { openQuickSellModal(st, 'UPI'); } }
      });
      var cashBtn = el('button', {
        cls: 'btn btn-sm btn-warning flex-fill btn-press', text: 'Cash', attrs: { type: 'button', title: 'Quick sell with Cash' },
        on: { click: function () { openQuickSellModal(st, 'Cash'); } }
      });
      var laterBtn = el('button', {
        cls: 'btn btn-sm btn-outline-danger flex-fill btn-press', text: 'Later', attrs: { type: 'button', title: 'Record credit / pay later' },
        on: { click: function () { openQuickSellModal(st, 'Pending'); } }
      });
      if (out) { upiBtn.disabled = true; cashBtn.disabled = true; laterBtn.disabled = true; }
      box.appendChild(el('div', { cls: 'col-6 col-md-4 col-xl-3' },
        el('div', { cls: 'quick-card' + (out ? ' is-out' : '') },
          el('div', { cls: 'quick-name', text: st.brand }),
          el('div', { cls: 'quick-meta', text: moneyTight(st.rate) + ' • ' + (out ? 'Out of stock' : st.closing + ' left') }),
          el('div', { cls: 'd-flex gap-1' }, upiBtn, cashBtn, laterBtn))));
    });
  }

  function fillBrandSelect(select, selected) {
    var keep = selected || select.value;
    clear(select);
    state.stock.forEach(function (st) {
      select.appendChild(el('option', { text: st.brand, attrs: { value: st.brand } }));
    });
    if (keep) select.value = keep;
  }

  /* ------------------------------------------------------------------
   * Data loading
   * ------------------------------------------------------------------ */
  function load() {
    return api('/api/dashboard?date=' + encodeURIComponent(state.date)).then(function (d) {
      d = d || {};
      state.stock = d.stock || [];
      state.sales = d.sales || [];
      state.summary = d.summary || {};
      renderSummary(d.summary, d.date || state.date);
      renderSales();
      renderStock(d.stock || []);
      renderPayment(d.summary);
      renderAlerts(d.alerts || []);
      renderQuickSell(d.stock || []);
      renderPending(d.pending, d.summary);
    }).catch(function (e) { toast(e.message, 'danger'); });
  }

  function deleteSale(sale) {
    if (!window.confirm('Delete sale of ' + sale.qty + ' × ' + sale.brand + ' for ' + sale.customer + '?')) return;
    api('/api/sales/' + encodeURIComponent(sale.id), { method: 'DELETE' })
      .then(function () { toast('Sale deleted'); return load(); })
      .catch(function (e) { toast(e.message, 'danger'); });
  }

  /* ------------------------------------------------------------------
   * Quick Sell Modal (Custom HTML/CSS Dialog for Cash/UPI/Later)
   * ------------------------------------------------------------------ */
  var quickSellModal = new bootstrap.Modal($('quickSellModal'));
  var qsCurrentStock = null;

  function updateQuickSellTotal() {
    if (!qsCurrentStock) return;
    var q = parseInt($('qsQty').value, 10) || 1;
    var total = q * qsCurrentStock.rate;
    $('qsTotal').textContent = moneyTight(total);
    var mode = document.querySelector('input[name="qsMode"]:checked').value;
    if (mode === 'Pending') {
      $('qsSubmit').textContent = 'Record Pending (' + moneyTight(total) + ')';
    } else {
      $('qsSubmit').textContent = 'Sell Now (' + mode + ' • ' + moneyTight(total) + ')';
    }
  }

  function syncQuickSellUI() {
    var mode = document.querySelector('input[name="qsMode"]:checked').value;
    var isPending = mode === 'Pending';
    $('qsRemarksBox').classList.toggle('d-none', !isPending);
    if (isPending) {
      $('qsCustomerLabel').textContent = 'Customer Name * (Required for credit)';
      $('qsHint').textContent = 'Enter the customer name who will pay later.';
      $('qsTitle').textContent = '⏳ Pay Later (Credit) — ' + (qsCurrentStock ? qsCurrentStock.brand : '');
    } else {
      $('qsCustomerLabel').textContent = 'Customer Name';
      $('qsHint').textContent = 'Enter customer name (or leave as Walk-in).';
      $('qsTitle').textContent = '⚡ Quick Sell (' + mode + ') — ' + (qsCurrentStock ? qsCurrentStock.brand : '');
    }
    updateQuickSellTotal();
  }

  Array.prototype.forEach.call(document.querySelectorAll('input[name="qsMode"]'), function (r) {
    r.addEventListener('change', syncQuickSellUI);
  });

  $('qsQtyMinus').addEventListener('click', function () {
    var val = Math.max(1, (parseInt($('qsQty').value, 10) || 1) - 1);
    $('qsQty').value = val;
    updateQuickSellTotal();
  });

  $('qsQtyPlus').addEventListener('click', function () {
    var maxVal = qsCurrentStock ? qsCurrentStock.closing : 999;
    var val = Math.min(maxVal, (parseInt($('qsQty').value, 10) || 1) + 1);
    $('qsQty').value = val;
    updateQuickSellTotal();
  });

  $('qsQty').addEventListener('input', updateQuickSellTotal);

  function openQuickSellModal(st, mode) {
    qsCurrentStock = st;
    $('quickSellForm').reset();
    $('quickSellForm').classList.remove('was-validated');
    hideErr($('qsError'));

    $('qsBrand').textContent = st.brand;
    $('qsRate').textContent = moneyTight(st.rate) + ' / bottle';
    $('qsQty').value = 1;
    $('qsQty').max = Math.max(st.closing, 1);
    $('qsCustomer').value = mode === 'Pending' ? '' : 'Walk-in';

    if (mode === 'UPI') $('qsModeUpi').checked = true;
    else if (mode === 'Cash') $('qsModeCash').checked = true;
    else $('qsModeLater').checked = true;

    syncQuickSellUI();
    quickSellModal.show();
    setTimeout(function () {
      $('qsCustomer').focus();
      if ($('qsCustomer').value) $('qsCustomer').select();
    }, 250);
  }

  $('quickSellForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    form.classList.add('was-validated');
    if (!form.checkValidity()) return;

    var mode = document.querySelector('input[name="qsMode"]:checked').value;
    var isPending = mode === 'Pending';
    var customer = $('qsCustomer').value.trim();
    if (isPending && !customer) {
      showErr($('qsError'), 'Customer name is required for pending credit');
      $('qsCustomer').focus();
      return;
    }
    if (!customer) customer = 'Walk-in';

    var qty = parseInt($('qsQty').value, 10) || 1;
    var remarks = $('qsRemarks').value.trim() || (isPending ? 'Credit sale' : 'Quick sell');

    $('qsSubmit').disabled = true;
    api('/api/sales', {
      method: 'POST',
      body: {
        date: state.date,
        time: nowHHMM(),
        customer: customer,
        brand: qsCurrentStock.brand,
        qty: qty,
        rate: qsCurrentStock.rate,
        status: isPending ? 'Pending' : 'Paid',
        payment: isPending ? '' : mode,
        remarks: remarks
      }
    }).then(function (sale) {
      state.newIds[sale.id] = true;
      quickSellModal.hide();
      toast(isPending
        ? qty + ' × ' + qsCurrentStock.brand + ' on credit for ' + customer
        : qty + ' × ' + qsCurrentStock.brand + ' sold (' + mode + ') to ' + customer,
        isPending ? 'warning' : 'success');
      return load();
    }).catch(function (err) {
      showErr($('qsError'), err.message);
    }).finally(function () {
      $('qsSubmit').disabled = false;
    });
  });

  /* ------------------------------------------------------------------
   * Sale modal (add + edit)
   * ------------------------------------------------------------------ */
  var saleModal = new bootstrap.Modal($('saleModal'));
  var restockModal = new bootstrap.Modal($('restockModal'));
  var brandModal = new bootstrap.Modal($('brandModal'));

  function currentStock(brand) {
    return state.stock.filter(function (s) { return s.brand === brand; })[0];
  }

  function updateSaleAmount() {
    var q = parseFloat($('sQty').value) || 0;
    var r = parseFloat($('sRate').value) || 0;
    $('sAmount').value = (q * r).toLocaleString('en-IN');
  }

  function updateStockHint(extra) {
    var st = currentStock($('sBrand').value);
    if (!st) return;
    var avail = st.closing + (extra || 0);
    $('sStockHint').textContent = 'In stock: ' + avail + ' bottle' + (avail === 1 ? '' : 's');
    $('sQty').max = Math.max(avail, 1);
  }

  function onSaleBrandChange() {
    var st = currentStock($('sBrand').value);
    if (!st) return;
    $('sRate').value = st.rate;
    var extra = state.editId && state.sales.some(function (s) { return s.id === state.editId && s.brand === st.brand; })
      ? state.sales.filter(function (s) { return s.id === state.editId; })[0].qty : 0;
    updateStockHint(extra);
    updateSaleAmount();
  }

  // hide the payment-mode buttons while a sale is "Pending" (mode is chosen when collected)
  function syncStatusUI() {
    $('payModeBox').classList.toggle('d-none', $('stPending').checked);
  }
  Array.prototype.forEach.call(document.querySelectorAll('input[name="sStatus"]'), function (r) {
    r.addEventListener('change', syncStatusUI);
  });

  // sale === undefined => add mode, otherwise edit that sale
  function openSaleModal(sale) {
    if (!state.stock.length) { toast('Add a juice brand first', 'warning'); return; }
    var form = $('saleForm');
    form.reset();
    form.classList.remove('was-validated');
    hideErr($('saleError'));
    state.editId = sale ? sale.id : null;
    $('saleModalTitle').textContent = sale ? 'Edit Sale' : 'Add Sale';
    $('saleSubmit').textContent = sale ? 'Update sale' : 'Save sale';
    fillBrandSelect($('sBrand'), sale ? sale.brand : undefined);

    if (sale) {
      $('sCustomer').value = sale.customer;
      $('sTime').value = sale.time;
      $('sQty').value = sale.qty;
      $('sRate').value = sale.rate;
      $('sRemarks').value = sale.remarks || '';
      (sale.payment === 'Cash' ? $('payCash') : $('payUpi')).checked = true;
      (sale.status === 'Pending' ? $('stPending') : $('stPaid')).checked = true;
      updateStockHint(sale.qty);
      updateSaleAmount();
    } else {
      $('sTime').value = nowHHMM();
      $('sQty').value = 1;
      $('payUpi').checked = true;
      onSaleBrandChange();
    }
    syncStatusUI();
    saleModal.show();
  }

  $('btnAddSale').addEventListener('click', function () { openSaleModal(); });
  $('sBrand').addEventListener('change', onSaleBrandChange);
  $('sQty').addEventListener('input', updateSaleAmount);
  $('sRate').addEventListener('input', updateSaleAmount);

  $('saleForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    form.classList.add('was-validated');
    if (!form.checkValidity()) return;
    hideErr($('saleError'));

    var editing = state.editId;
    var body = {
      date: state.date,
      time: $('sTime').value,
      customer: $('sCustomer').value.trim(),
      brand: $('sBrand').value,
      qty: parseInt($('sQty').value, 10),
      rate: parseFloat($('sRate').value),
      status: document.querySelector('input[name="sStatus"]:checked').value,
      payment: $('stPending').checked ? '' : document.querySelector('input[name="sPay"]:checked').value,
      remarks: $('sRemarks').value.trim()
    };
    var req = editing
      ? api('/api/sales/' + encodeURIComponent(editing), { method: 'PUT', body: body })
      : api('/api/sales', { method: 'POST', body: body });

    req.then(function (res) {
      if (!editing && res && res.id) state.newIds[res.id] = true;
      saleModal.hide();
      toast(editing ? 'Sale updated' : 'Sale added');
      return load();
    }).catch(function (err) { showErr($('saleError'), err.message); });
  });

  /* ------------------------------------------------------------------
   * Collect pending payments
   * ------------------------------------------------------------------ */
  var payModal = new bootstrap.Modal($('payModal'));
  var payIds = [];

  function setPayBusy(busy) {
    $('payUpiBtn').disabled = busy;
    $('payCashBtn').disabled = busy;
  }

  function openPayModal(ids, who, amount) {
    payIds = ids;
    $('payWho').textContent = who;
    $('payAmount').textContent = money(amount);
    hideErr($('payError'));
    setPayBusy(false);
    payModal.show();
  }

  function collect(mode) {
    setPayBusy(true);
    api('/api/sales/pay', { method: 'POST', body: { ids: payIds, payment: mode } })
      .then(function (res) {
        payModal.hide();
        toast('Payment collected via ' + mode + ' (' + res.updated + ' sale' + (res.updated === 1 ? '' : 's') + ')');
        return load();
      })
      .catch(function (err) { showErr($('payError'), err.message); setPayBusy(false); });
  }
  $('payUpiBtn').addEventListener('click', function () { collect('UPI'); });
  $('payCashBtn').addEventListener('click', function () { collect('Cash'); });

  function showPending() {
    $('pendingPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  $('pendingCard').addEventListener('click', showPending);
  $('pendingCard').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showPending(); }
  });

  /* ------------------------------------------------------------------
   * Restock + brand modals
   * ------------------------------------------------------------------ */
  function openRestockModal(brand) {
    if (!state.stock.length) { toast('Add a juice brand first', 'warning'); return; }
    $('restockForm').reset();
    $('restockForm').classList.remove('was-validated');
    hideErr($('restockError'));
    fillBrandSelect($('rBrand'), brand);
    restockModal.show();
    $('restockModal').addEventListener('shown.bs.modal', function focusQty() {
      $('rQty').focus();
      $('restockModal').removeEventListener('shown.bs.modal', focusQty);
    });
  }

  $('btnRestock').addEventListener('click', function () { openRestockModal(); });

  $('restockForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    form.classList.add('was-validated');
    if (!form.checkValidity()) return;
    api('/api/purchases', {
      method: 'POST',
      body: { date: state.date, brand: $('rBrand').value, qty: parseInt($('rQty').value, 10) }
    }).then(function () {
      restockModal.hide();
      toast('Stock added');
      return load();
    }).catch(function (err) { showErr($('restockError'), err.message); });
  });

  $('btnBrand').addEventListener('click', function () {
    $('brandForm').reset();
    $('brandForm').classList.remove('was-validated');
    $('bInitial').disabled = false;
    hideErr($('brandError'));
    api('/api/products').then(function (d) {
      state.products = d.products;
      var list = $('brandList');
      clear(list);
      d.products.forEach(function (p) { list.appendChild(el('option', { attrs: { value: p.name } })); });
      brandModal.show();
    }).catch(function (err) { toast(err.message, 'danger'); });
  });

  $('bName').addEventListener('input', function () {
    var name = $('bName').value.trim();
    var p = state.products.filter(function (x) { return x.name === name; })[0];
    if (p) {
      $('bRate').value = p.rate; $('bCost').value = p.cost; $('bLow').value = p.lowStock;
      $('bInitial').value = p.initialStock; $('bInitial').disabled = true;
    } else {
      $('bInitial').disabled = false;
    }
  });

  $('brandForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.currentTarget;
    form.classList.add('was-validated');
    if (!form.checkValidity()) return;
    var body = {
      name: $('bName').value.trim(),
      rate: parseFloat($('bRate').value),
      cost: parseFloat($('bCost').value),
      lowStock: parseInt($('bLow').value, 10)
    };
    if (!$('bInitial').disabled) body.initialStock = parseInt($('bInitial').value || '0', 10);
    api('/api/products', { method: 'POST', body: body }).then(function () {
      brandModal.hide();
      toast('Brand saved');
      return load();
    }).catch(function (err) { showErr($('brandError'), err.message); });
  });

  /* ------------------------------------------------------------------
   * Delete brand modal
   * ------------------------------------------------------------------ */
  var deleteBrandModal = new bootstrap.Modal($('deleteBrandModal'));

  function updateDeleteBrandWarning() {
    var val = $('delBrandSelect').value;
    var st = currentStock(val);
    if (st) {
      $('delBrandWarning').textContent = '⚠️ Current stock: ' + st.closing + ' bottle' + (st.closing === 1 ? '' : 's') + ' (' + st.status + ')';
    } else {
      $('delBrandWarning').textContent = '';
    }
  }

  $('delBrandSelect').addEventListener('change', updateDeleteBrandWarning);

  $('btnDeleteBrand').addEventListener('click', function () {
    if (!state.stock.length) { toast('No brands to delete', 'warning'); return; }
    hideErr($('delBrandError'));
    var sel = $('delBrandSelect');
    clear(sel);
    state.stock.forEach(function (st) {
      sel.appendChild(el('option', { text: st.brand, attrs: { value: st.brand } }));
    });
    updateDeleteBrandWarning();
    deleteBrandModal.show();
  });

  $('deleteBrandForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var brand = $('delBrandSelect').value;
    if (!brand) return;
    if (!window.confirm('Are you sure you want to delete "' + brand + '" from the brands list?')) return;

    $('delBrandSubmit').disabled = true;
    api('/api/products/' + encodeURIComponent(brand), { method: 'DELETE' })
      .then(function () {
        deleteBrandModal.hide();
        toast('Brand "' + brand + '" deleted successfully', 'warning');
        return load();
      })
      .catch(function (err) {
        showErr($('delBrandError'), err.message);
      })
      .finally(function () {
        $('delBrandSubmit').disabled = false;
      });
  });

  /* ------------------------------------------------------------------
   * Toolbar: day navigation, refresh, CSV, print
   * ------------------------------------------------------------------ */
  function goToDate(iso) {
    state.date = iso;
    $('dateInput').value = iso;
    load();
  }

  $('dateInput').addEventListener('change', function () {
    if (!this.value) { this.value = state.date; return; }
    goToDate(this.value);
  });
  if ($('btnToday')) $('btnToday').addEventListener('click', function () { goToDate(todayISO()); });

  $('btnRefresh').addEventListener('click', function () {
    var icon = $('btnRefresh');
    icon.disabled = true;
    icon.firstChild.nodeValue = '⏳ Refreshing…';
    load().then(function () {
      icon.firstChild.nodeValue = '🔄 Refresh';
      icon.disabled = false;
      toast('Data refreshed', 'info');
    });
  });

  $('btnCsv').addEventListener('click', function () {
    var date = state.date || todayISO();
    toast('Downloading CSV export for ' + displayDate(date) + '…', 'info');
    window.location.href = '/api/export-csv?date=' + encodeURIComponent(date);
  });

  /* ------------------------------------------------------------------
   * Filters
   * ------------------------------------------------------------------ */
  $('payFilter').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-filter]');
    if (!b) return;
    state.filter = b.getAttribute('data-filter');
    renderSales();
  });

  $('searchBox').addEventListener('input', function () {
    state.query = this.value;
    renderSales();
  });

  $('btnClearFilter').addEventListener('click', function () {
    state.filter = 'All';
    state.query = '';
    $('searchBox').value = '';
    renderSales();
  });

  // Summary cards act as shortcuts
  $('cSplit').closest('.stat-card').style.cursor = 'pointer';
  $('cSplit').closest('.stat-card').title = 'Click to cycle All → Cash → UPI';
  $('cSplit').closest('.stat-card').addEventListener('click', function () {
    var order = ['All', 'Cash', 'UPI'];
    state.filter = order[(order.indexOf(state.filter) + 1) % order.length];
    renderSales();
    $('salesTable').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // Keyboard shortcuts (ignored while typing in a field)
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.modal.show')) return;
    if (e.key === 'n') { e.preventDefault(); openSaleModal(); }
    else if (e.key === '/') { e.preventDefault(); $('searchBox').focus(); }
  });

  $('logoutBtn').addEventListener('click', function () {
    api('/api/logout', { method: 'POST' }).finally(function () { window.location.href = '/login'; });
  });

  /* ------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------ */
  $('dateInput').value = state.date;
  api('/api/me').then(function (me) { if (me) $('userName').textContent = me.name || me.username; });
  load();
})();
