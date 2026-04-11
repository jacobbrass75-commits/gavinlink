#!/usr/bin/env python3
"""
CA SOS Manager Lookup via Safari automation.
Extracts MANAGER from Statement of Information PDF.
Uses 5 parallel Safari tabs for speed.
"""

import csv, json, subprocess, time, re, os, sys, base64, io
import requests, urllib.parse
from pypdf import PdfReader
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

CSV_PATH = "/Users/josephsullivan/Downloads/5+ unit farm.csv"
PROGRESS_PATH = "/Users/josephsullivan/Downloads/llc_manager_progress.json"
OUTPUT_PATH = "/Users/josephsullivan/Downloads/LLC_Managers_Contact_Info.xlsx"
RR_KEY = "5e7018k68acf1cddcba48393924fe3f38f1e756"
SOS_URL = "https://bizfileonline.sos.ca.gov/search/business"
HEADERS_HTTP = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}

NUM_WORKERS = 4
progress_lock = threading.Lock()
print_lock = threading.Lock()


def sjs(js_code, tab_idx=1):
    """Run JavaScript in a specific Safari tab."""
    tmp = f'/tmp/_sjs_{tab_idx}.js'
    with open(tmp, 'w') as f:
        f.write(js_code)
    r = subprocess.run(['osascript'], input=f'''
set f to POSIX file "{tmp}"
set c to read f as «class utf8»
tell application "Safari" to tell tab {tab_idx} of window 1 to do JavaScript c
''', capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


def osa(script):
    """Run AppleScript."""
    r = subprocess.run(['osascript'], input=script, capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


def load_progress():
    if os.path.exists(PROGRESS_PATH):
        with open(PROGRESS_PATH, 'r') as f:
            return json.load(f)
    return {}


def save_progress(data):
    with open(PROGRESS_PATH, 'w') as f:
        json.dump(data, f, indent=2)


def extract_managers_from_pdf(b64_data):
    """Extract Manager name(s) from base64-encoded SI PDF."""
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


def wait_for_page(tab_idx=1):
    """Wait for the SOS search page to be ready in a specific tab."""
    for attempt in range(5):
        time.sleep(6)
        r = sjs("document.querySelector('.search-input') ? 'ready' : document.body.innerText.substring(0,50);", tab_idx)
        if r == 'ready':
            return True
        if '502' in r or 'Bad Gateway' in r:
            with print_lock:
                print(f"[Tab{tab_idx}][502 - retrying in 15s]", end=' ', flush=True)
            time.sleep(15)
            osa(f'tell application "Safari" to set URL of tab {tab_idx} of window 1 to "{SOS_URL}"')
        else:
            time.sleep(2)
    return False


def lookup_llc(llc_name, tab_idx=1):
    """Full lookup flow for one LLC using a specific Safari tab."""
    safe = llc_name.replace('\\', '\\\\').replace("'", "\\'").replace('"', '\\"').replace('\n', ' ')

    # 1. Reload page
    osa(f'tell application "Safari" to set URL of tab {tab_idx} of window 1 to "{SOS_URL}"')
    if not wait_for_page(tab_idx):
        return None

    # 2. Enter name and search
    sjs(f"""
        var input = document.querySelector('.search-input');
        var ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        ns.call(input, '');
        input.dispatchEvent(new Event('input', {{bubbles: true}}));
        ns.call(input, '{safe}');
        input.dispatchEvent(new Event('input', {{bubbles: true}}));
        input.dispatchEvent(new Event('change', {{bubbles: true}}));
        'set';
    """, tab_idx)
    time.sleep(0.5)
    sjs("var b=document.querySelector('.search-button'); if(b) b.click(); 'ok';", tab_idx)
    time.sleep(6)

    # 3. Check results
    r = sjs("""
        var cells = document.querySelectorAll('td.div-table-cell.interactive');
        if (cells.length > 0) {
            var res = []; cells.forEach(function(c){res.push(c.innerText.trim())});
            res.join('|||');
        } else { 'NO_RESULTS'; }
    """, tab_idx)
    if not r or 'NO_RESULTS' in r:
        return None

    # 4. Find best match and click
    entities = r.split('|||')
    llc_core = re.sub(r'\s+LLC\s*$', '', re.sub(r'[,.\s]+', ' ', llc_name.upper())).strip()
    best = 0
    for i, e in enumerate(entities):
        ec = re.sub(r'\s+LLC\s*$', '', re.sub(r'\s*\(\d+\)\s*$', '', re.sub(r'[,.\s]+', ' ', e.upper()))).strip()
        if ec == llc_core or llc_core in ec or ec in llc_core:
            best = i
            break

    sjs(f"var c=document.querySelectorAll('td.div-table-cell.interactive'); if(c[{best}]) c[{best}].click(); 'ok';", tab_idx)
    time.sleep(4)

    # 5. Click View History
    sjs('var b=document.querySelector("button[aria-label=\'View History\']"); if(b) b.click(); "ok";', tab_idx)
    time.sleep(3)

    # 6. Check modal
    mc = sjs("var m=document.querySelector('.history-modal'); m ? 'found' : 'none';", tab_idx)
    if mc != 'found':
        time.sleep(3)
        mc = sjs("var m=document.querySelector('.history-modal'); m ? 'found' : 'none';", tab_idx)
        if mc != 'found':
            return None

    # 7. Expand first SI
    sjs("""
        var modal = document.querySelector('.history-modal');
        var wraps = modal.querySelectorAll('.amendment-wrapper');
        for (var i=0; i<wraps.length; i++) {
            var t = wraps[i].querySelector('button.title');
            if (t && t.innerText.indexOf('Statement of Information') >= 0) {
                if (t.classList.contains('collapsed')) t.click();
                break;
            }
        }
        'ok';
    """, tab_idx)
    time.sleep(2)

    # 8. Get PDF URL
    pdf_url = sjs("var m=document.querySelector('.history-modal'); var l=m?m.querySelectorAll('a[href*=\"GetImageByNum\"]'):[];l.length>0?l[0].href:'NO';", tab_idx)
    if not pdf_url or pdf_url == 'NO':
        sjs("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();", tab_idx)
        return None

    pdf_path = pdf_url.replace('https://bizfileonline.sos.ca.gov', '')

    # 9. Fetch PDF as base64
    sjs(f"""
        fetch('{pdf_path}')
        .then(function(r){{ return r.arrayBuffer(); }})
        .then(function(buf){{
            var bytes = new Uint8Array(buf);
            var bin = '';
            for(var i=0; i<bytes.length; i+=8192){{
                var ch = bytes.subarray(i, Math.min(i+8192, bytes.length));
                for(var j=0; j<ch.length; j++) bin += String.fromCharCode(ch[j]);
            }}
            window._pdfB64 = btoa(bin);
            document.title = 'PDF_READY';
        }})
        .catch(function(e){{ document.title = 'PDF_ERROR:'+e.message; }});
        'fetching';
    """, tab_idx)

    for _ in range(15):
        time.sleep(1)
        title = osa(f'tell application "Safari" to return name of tab {tab_idx} of window 1')
        if 'PDF_READY' in title or 'PDF_ERROR' in title:
            break

    if 'PDF_ERROR' in (title or ''):
        sjs("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();", tab_idx)
        return None

    # 10. Get base64
    b64 = sjs("window._pdfB64 || '';", tab_idx)
    sjs("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();", tab_idx)

    if not b64 or len(b64) < 100:
        return None

    return extract_managers_from_pdf(b64)


def load_llcs():
    with open(CSV_PATH, 'r') as f:
        rows = list(csv.DictReader(f))
    llc_data = {}
    for r in rows:
        owner = r['Owner Name'].strip()
        if 'llc' not in owner.lower():
            continue
        if owner not in llc_data:
            llc_data[owner] = {
                'properties': [],
                'mail_address': r.get('Mail Address', '').strip(),
                'mail_city': r.get('Mail Address City', '').strip(),
            }
        addr = f"{r.get('Site Address','').strip()}, {r.get('Site Address City','').strip()}"
        units = r.get('Number of Units', '')
        prop = f"{addr} ({units} units)" if units else addr
        if prop not in llc_data[owner]['properties']:
            llc_data[owner]['properties'].append(prop)
    return llc_data


def generate_excel(llc_data, progress):
    import openpyxl
    from openpyxl.styles import Font
    wb = openpyxl.Workbook()
    headers = ['LLC Name', 'Properties', '# Properties', 'Mail Address', 'Mail City',
               'Manager Name', 'Email', 'Phone', 'LinkedIn', 'Agent Name', 'CEO']

    ws = wb.active
    ws.title = "With Contact Info"
    ws.append(headers)
    for c in ws[1]: c.font = Font(bold=True)
    cr = 0
    for llc, d in llc_data.items():
        p = progress.get(llc, {})
        for m in [m for m in p.get('managers', []) if m.get('email') or m.get('phone')]:
            ws.append([llc, "; ".join(d['properties']), len(d['properties']),
                       d['mail_address'], d['mail_city'], m.get('name',''), m.get('email',''),
                       m.get('phone',''), m.get('linkedin',''), p.get('agent',''), p.get('ceo','')])
            cr += 1

    ws2 = wb.create_sheet("All Managers")
    ws2.append(headers)
    for c in ws2[1]: c.font = Font(bold=True)
    ar = 0
    for llc, d in llc_data.items():
        p = progress.get(llc, {})
        for m in p.get('managers', []):
            ws2.append([llc, "; ".join(d['properties']), len(d['properties']),
                        d['mail_address'], d['mail_city'], m.get('name',''), m.get('email',''),
                        m.get('phone',''), m.get('linkedin',''), p.get('agent',''), p.get('ceo','')])
            ar += 1

    for s in [ws, ws2]:
        for col in s.columns:
            ml = max(len(str(c.value or '')[:50]) for c in col)
            s.column_dimensions[col[0].column_letter].width = min(ml + 2, 50)
    wb.save(OUTPUT_PATH)
    print(f"\nExcel saved: {OUTPUT_PATH}")
    print(f"Sheet 1 (with contact): {cr} rows | Sheet 2 (all managers): {ar} rows")


def process_llc(llc_name, tab_idx, llc_data, skip_contact):
    """Process a single LLC on a given tab. Returns (llc_name, result_dict)."""
    try:
        result = lookup_llc(llc_name, tab_idx)

        if result and (result.get('managers') or result.get('agent')):
            raw = result.get('managers', [])
            agent = result.get('agent')
            ceo = result.get('ceo')
            llc_low = llc_name.lower().strip()

            # Filter out company names
            persons = [n for n in raw
                       if not any(x in n.lower() for x in ['llc','inc','corp','company','l.l.c','trust','l.p.'])
                       and n.lower().strip() != llc_low.replace(',', '')
                       and len(n) > 2 and re.match(r'^[A-Z]', n)]

            # Fallback to agent
            if not persons and agent:
                ac = agent.strip()
                if not any(x in ac.lower() for x in ['llc','inc','corp','trust']) and len(ac.split()) >= 2:
                    persons = [ac.title() if ac == ac.upper() else ac]

            mgr_list = []
            for name in persons:
                if name == name.upper() and len(name) > 2:
                    name = name.title()
                mgr_list.append({'name': name, 'role': 'Manager/Member'})

            entry = {'done': True, 'managers': mgr_list, 'agent': agent, 'ceo': ceo}
            names = ', '.join(m['name'] for m in mgr_list)
            return (llc_name, entry, f"MANAGER: {names}" if mgr_list else "NO PERSON MANAGER")
        else:
            return (llc_name, {'done': True, 'managers': []}, "NOT FOUND")

    except Exception as e:
        return (llc_name, {'done': True, 'managers': [], 'error': str(e)}, f"ERROR: {e}")


def worker(tab_idx, work_queue, progress, llc_data, skip_contact, counters, total):
    """Worker thread: pulls LLCs from shared queue and processes them."""
    while True:
        # Get next item
        with progress_lock:
            llc_name = None
            while work_queue:
                candidate = work_queue.pop(0)
                if candidate not in progress or not progress[candidate].get('done'):
                    llc_name = candidate
                    break
            if llc_name is None:
                return

            idx = total - len(work_queue)

        with print_lock:
            print(f"[T{tab_idx}][{idx}/{total}] {llc_name}...", end=' ', flush=True)

        llc_name_r, entry, msg = process_llc(llc_name, tab_idx, llc_data, skip_contact)

        with progress_lock:
            existing = progress.get(llc_name_r, {})
            if entry.get('managers'):
                # SOS found managers — merge: keep existing contact info for matching names
                existing_by_name = {}
                for m in existing.get('managers', []):
                    existing_by_name[m.get('name', '').strip().lower()] = m
                for m in entry['managers']:
                    key = m['name'].strip().lower()
                    if key in existing_by_name:
                        old = existing_by_name[key]
                        if old.get('email'): m['email'] = old['email']
                        if old.get('phone'): m['phone'] = old['phone']
                        if old.get('linkedin'): m['linkedin'] = old['linkedin']
                entry['managers'] = entry['managers']
                progress[llc_name_r] = entry
                counters['found'] += 1
            else:
                # SOS didn't find managers — keep existing data, just mark done
                existing['done'] = True
                progress[llc_name_r] = existing
            counters['processed'] += 1

            if counters['processed'] % 25 == 0:
                save_progress(progress)
                with print_lock:
                    print(f"\n  --- {counters['processed']} processed | {counters['found']} managers found ---")

        with print_lock:
            print(msg)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    limit = int(args[0]) if args else None
    skip_contact = '--no-contact' in sys.argv

    print("Loading LLCs...")
    llc_data = load_llcs()
    llc_names = list(llc_data.keys())
    if limit:
        llc_names = llc_names[:limit]
    total_all = len(llc_names)
    print(f"Total LLCs: {total_all}")

    progress = load_progress()
    already_done = sum(1 for n in llc_names if n in progress and progress[n].get('done'))
    print(f"Already done: {already_done}, remaining: {total_all - already_done}")

    # Build work queue (only undone LLCs)
    work_queue = [n for n in llc_names if n not in progress or not progress[n].get('done')]
    remaining = len(work_queue)

    if remaining == 0:
        print("All LLCs already processed!")
        print("Generating Excel...")
        generate_excel(llc_data, progress)
        return

    # Setup Safari with NUM_WORKERS tabs
    print(f"Opening Safari with {NUM_WORKERS} tabs...")
    osa(f'''
tell application "Safari"
    activate
    if (count of windows) = 0 then
        make new document with properties {{URL:"{SOS_URL}"}}
    end if
    tell window 1
        -- Ensure we have {NUM_WORKERS} tabs
        repeat while (count of tabs) < {NUM_WORKERS}
            set current tab to (make new tab with properties {{URL:"{SOS_URL}"}})
        end repeat
        -- Set all tabs to SOS URL
        repeat with i from 1 to {NUM_WORKERS}
            set URL of tab i to "{SOS_URL}"
        end repeat
    end tell
end tell
    ''')
    time.sleep(8)

    counters = {'found': 0, 'processed': 0}

    print(f"\nStarting {NUM_WORKERS} parallel workers for {remaining} LLCs...")
    print(f"Estimated time: ~{remaining * 20 // NUM_WORKERS // 60} minutes\n")

    threads = []
    for tab_idx in range(1, NUM_WORKERS + 1):
        t = threading.Thread(
            target=worker,
            args=(tab_idx, work_queue, progress, llc_data, skip_contact, counters, remaining)
        )
        t.start()
        threads.append(t)
        time.sleep(1)  # Stagger starts slightly

    for t in threads:
        t.join()

    save_progress(progress)

    total_found = sum(1 for v in progress.values() if v.get('managers'))
    print(f"\n=== COMPLETE ===")
    print(f"Total processed: {total_all}")
    print(f"Managers found: {total_found} ({100*total_found//max(total_all,1)}%)")
    print("\nGenerating Excel...")
    generate_excel(llc_data, progress)


if __name__ == '__main__':
    main()
