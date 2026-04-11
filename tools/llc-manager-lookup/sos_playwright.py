#!/usr/bin/env python3
"""
CA SOS Manager Lookup using Playwright (headless Chromium).
Runs 6 parallel browsers for speed.
"""
import json, re, time, base64, io, sys
from pypdf import PdfReader
from playwright.sync_api import sync_playwright
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

PROGRESS_PATH = "/root/progress.json"
SOS_URL = "https://bizfileonline.sos.ca.gov/search/business"
NUM_WORKERS = 6

progress_lock = threading.Lock()
print_lock = threading.Lock()


def extract_managers_from_pdf(b64_data):
    try:
        pdf_bytes = base64.b64decode(b64_data)
        reader = PdfReader(io.BytesIO(pdf_bytes))
        full_text = ""
        for page in reader.pages:
            t = page.extract_text()
            if t:
                full_text += t + "\n"

        managers = []
        m = re.search(
            r'Manager or Member Name\s+Manager or Member Address\s*\n(.+?)(?=Agent for Service|Type of Business|Email Notification|Chief Executive|Labor Judgment|$)',
            full_text, re.DOTALL
        )
        if m:
            for line in [l.strip() for l in m.group(1).strip().split('\n') if l.strip()]:
                nm = re.match(r'^([A-Za-z][A-Za-z\s.,\'-]+?)\s+\d+', line)
                if nm:
                    name = nm.group(1).strip().rstrip('.,').strip()
                    if len(name) > 2 and 'none entered' not in name.lower():
                        managers.append(name)
                elif len(line) > 2 and re.match(r'^[A-Z]', line) and not re.search(r'\d{5}', line):
                    name = line.strip().rstrip('.,')
                    if not any(x in name.lower() for x in ['none entered', 'n/a', 'manager or']):
                        managers.append(name)

        agent = None
        am = re.search(r'Agent Name\s+(.+?)(?:\n|Agent Address)', full_text)
        if am:
            agent = am.group(1).strip()

        ceo = None
        cm = re.search(r'CEO Name\s+CEO Address\s*\n(.+?)(?=Labor|Electronic|$)', full_text, re.DOTALL)
        if cm and 'None Entered' not in cm.group(1):
            cn = re.match(r'^[+\s]*([A-Za-z][A-Za-z\s.,\'-]+?)\s+\d+', cm.group(1).strip())
            if cn:
                ceo = cn.group(1).strip().lstrip('+').strip()

        return {'managers': managers, 'agent': agent, 'ceo': ceo}
    except Exception as e:
        return {'managers': [], 'agent': None, 'ceo': None, 'error': str(e)}


def lookup_llc(page, llc_name):
    safe = llc_name.replace('"', '\\"')
    try:
        page.goto(SOS_URL, wait_until='networkidle', timeout=30000)
        page.wait_for_selector('.search-input', timeout=15000)

        # Enter name and search
        inp = page.query_selector('.search-input')
        inp.fill('')
        inp.fill(safe)
        time.sleep(0.3)
        btn = page.query_selector('.search-button')
        if btn:
            btn.click()
        time.sleep(3)
        page.wait_for_timeout(3000)

        # Check results
        cells = page.query_selector_all('td.div-table-cell.interactive')
        if not cells:
            return None

        # Find best match
        llc_core = re.sub(r'\s+LLC\s*$', '', re.sub(r'[,.\s]+', ' ', llc_name.upper())).strip()
        best = 0
        for i, cell in enumerate(cells):
            text = cell.inner_text().strip()
            ec = re.sub(r'\s+LLC\s*$', '', re.sub(r'\s*\(\d+\)\s*$', '', re.sub(r'[,.\s]+', ' ', text.upper()))).strip()
            if ec == llc_core or llc_core in ec or ec in llc_core:
                best = i
                break

        cells[best].click()
        time.sleep(3)

        # Click View History
        hist_btn = page.query_selector("button[aria-label='View History']")
        if not hist_btn:
            time.sleep(2)
            hist_btn = page.query_selector("button[aria-label='View History']")
        if not hist_btn:
            return None
        hist_btn.click()
        time.sleep(3)

        # Wait for modal
        modal = page.query_selector('.history-modal')
        if not modal:
            time.sleep(3)
            modal = page.query_selector('.history-modal')
        if not modal:
            return None

        # Expand first SI
        page.evaluate("""
            var modal = document.querySelector('.history-modal');
            var wraps = modal.querySelectorAll('.amendment-wrapper');
            for (var i=0; i<wraps.length; i++) {
                var t = wraps[i].querySelector('button.title');
                if (t && t.innerText.indexOf('Statement of Information') >= 0) {
                    if (t.classList.contains('collapsed')) t.click();
                    break;
                }
            }
        """)
        time.sleep(2)

        # Get PDF URL
        pdf_url = page.evaluate("""
            var m = document.querySelector('.history-modal');
            var links = m ? m.querySelectorAll('a[href*="GetImageByNum"]') : [];
            links.length > 0 ? links[0].href : null;
        """)
        if not pdf_url:
            page.evaluate("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")
            return None

        pdf_path = pdf_url.replace('https://bizfileonline.sos.ca.gov', '')

        # Fetch PDF as base64
        page.evaluate(f"""
            fetch('{pdf_path}')
            .then(r => r.arrayBuffer())
            .then(buf => {{
                var bytes = new Uint8Array(buf);
                var bin = '';
                for(var i=0; i<bytes.length; i+=8192){{
                    var ch = bytes.subarray(i, Math.min(i+8192, bytes.length));
                    for(var j=0; j<ch.length; j++) bin += String.fromCharCode(ch[j]);
                }}
                window._pdfB64 = btoa(bin);
                document.title = 'PDF_READY';
            }})
            .catch(e => {{ document.title = 'PDF_ERROR:' + e.message; }});
        """)

        for _ in range(20):
            time.sleep(1)
            title = page.title()
            if 'PDF_READY' in title or 'PDF_ERROR' in title:
                break

        if 'PDF_ERROR' in (title or ''):
            page.evaluate("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")
            return None

        b64 = page.evaluate("window._pdfB64 || ''")
        page.evaluate("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")

        if not b64 or len(b64) < 100:
            return None

        return extract_managers_from_pdf(b64)

    except Exception as e:
        return None


def worker(worker_id, work_queue, progress, counters, total):
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=['--disable-blink-features=AutomationControlled', '--no-sandbox']
        )
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport={'width': 1920, 'height': 1080},
        )
        page = context.new_page()
        page.add_init_script("""
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = {runtime: {}};
""")

        while True:
            with progress_lock:
                llc_name = None
                while work_queue:
                    candidate = work_queue.pop(0)
                    if candidate not in progress or not progress[candidate].get('done'):
                        llc_name = candidate
                        break
                if llc_name is None:
                    break
                idx = total - len(work_queue)

            try:
                result = lookup_llc(page, llc_name)

                if result and (result.get('managers') or result.get('agent')):
                    raw = result.get('managers', [])
                    agent = result.get('agent')
                    ceo = result.get('ceo')

                    persons = [n for n in raw
                               if not any(x in n.lower() for x in ['llc','inc','corp','company','l.l.c','trust','l.p.'])
                               and len(n) > 2 and re.match(r'^[A-Z]', n)]

                    if not persons and agent:
                        ac = agent.strip()
                        if not any(x in ac.lower() for x in ['llc','inc','corp','trust']) and len(ac.split()) >= 2:
                            persons = [ac.title() if ac == ac.upper() else ac]

                    mgr_list = []
                    for name in persons:
                        if name == name.upper() and len(name) > 2:
                            name = name.title()
                        mgr_list.append({'name': name, 'role': 'Manager/Member'})

                    with progress_lock:
                        existing = progress.get(llc_name, {})
                        existing_by_name = {}
                        for m in existing.get('managers', []):
                            existing_by_name[m.get('name', '').strip().lower()] = m
                        for m in mgr_list:
                            key = m['name'].strip().lower()
                            if key in existing_by_name:
                                old = existing_by_name[key]
                                if old.get('email'): m['email'] = old['email']
                                if old.get('phone'): m['phone'] = old['phone']
                                if old.get('linkedin'): m['linkedin'] = old['linkedin']
                        entry = {'done': True, 'managers': mgr_list, 'agent': agent, 'ceo': ceo}
                        progress[llc_name] = entry
                        counters['found'] += 1

                    names = ', '.join(m['name'] for m in mgr_list)
                    with print_lock:
                        print(f"[W{worker_id}][{idx}/{total}] {llc_name} -> {names}", flush=True)
                else:
                    with progress_lock:
                        existing = progress.get(llc_name, {})
                        existing['done'] = True
                        progress[llc_name] = existing

                    with print_lock:
                        print(f"[W{worker_id}][{idx}/{total}] {llc_name} -> NOT FOUND", flush=True)

            except Exception as e:
                with progress_lock:
                    existing = progress.get(llc_name, {})
                    existing['done'] = True
                    progress[llc_name] = existing
                with print_lock:
                    print(f"[W{worker_id}][{idx}/{total}] {llc_name} -> ERROR: {e}", flush=True)

            with progress_lock:
                counters['processed'] += 1
                if counters['processed'] % 25 == 0:
                    with open(PROGRESS_PATH, 'w') as f:
                        json.dump(progress, f, indent=2)
                    with print_lock:
                        print(f"  --- saved | {counters['processed']} done | {counters['found']} found ---", flush=True)

        browser.close()


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    work_queue = [k for k, v in progress.items() if not v.get('done')]
    total = len(work_queue)

    if total == 0:
        print("All LLCs already processed!")
        return

    print(f"LLCs to process: {total}")
    print(f"Running {NUM_WORKERS} parallel browsers\n")

    counters = {'found': 0, 'processed': 0}

    threads = []
    for i in range(NUM_WORKERS):
        t = threading.Thread(target=worker, args=(i+1, work_queue, progress, counters, total))
        t.start()
        threads.append(t)
        time.sleep(2)

    for t in threads:
        t.join()

    with open(PROGRESS_PATH, 'w') as f:
        json.dump(progress, f, indent=2)

    total_found = sum(1 for v in progress.values() if v.get('managers'))
    print(f"\n=== DONE ===")
    print(f"Managers found: {total_found}")
    print(f"New this run: {counters['found']}")


if __name__ == '__main__':
    main()
