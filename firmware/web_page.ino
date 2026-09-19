// The dashboard page, served from flash by web_server.ino.
// Polls /api/status every 2 s; operations POST to /api/reset-* with the admin
// password from the page (HTTP Basic, user "admin").

const char INDEX_HTML[] PROGMEM = R"rawliteral(<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prepaid Energy Meter</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--text:#1b1f24;--muted:#6a737d;--line:#e1e4e8;--accent:#0b6bcb;--ok:#1a7f37;--warn:#b35900;--bad:#c62828}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#171b22;--text:#e6e9ee;--muted:#8b949e;--line:#2a313c;--accent:#4c9aff;--ok:#3fb950;--warn:#e3a008;--bad:#f85149}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
h1{font-size:18px;margin:0}
h2{font-size:13px;margin:0 0 10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--bad);margin-right:6px}
.dot.on{background:var(--ok)}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.hero .big{font-size:38px;font-weight:700;line-height:1.1}
.hero.warn{border-color:var(--warn)}.hero.warn .big{color:var(--warn)}
.hero.bad{border-color:var(--bad)}.hero.bad .big{color:var(--bad)}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid currentColor}
.badge.ok{color:var(--ok)}.badge.bad{color:var(--bad)}.badge.warn{color:var(--warn)}
.row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row span:first-child{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;padding:4px 0;border-top:1px solid var(--line)}
th{color:var(--muted);font-weight:500;border-top:0}
label{display:block;font-size:13px;color:var(--muted);margin:8px 0 3px}
input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--text);font:inherit}
button{margin-top:10px;padding:9px 14px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.danger{background:var(--bad)}
button:disabled{opacity:.5}
#msg{margin-top:10px;font-size:14px;min-height:20px}
#msg.err{color:var(--bad)}#msg.good{color:var(--ok)}
.note{font-size:12px;color:var(--muted);margin-top:8px}
</style>
</head>
<body>
<main>
<header><h1>Prepaid Energy Meter</h1><div id="conn"><span class="dot" id="dot"></span><span id="connTxt">connecting...</span></div></header>
<div class="grid">
  <section class="card hero" id="balanceCard">
    <h2>Balance</h2>
    <div class="big" id="balance">--</div>
    <div style="margin-top:8px"><span class="badge" id="relayBadge">--</span> <span class="badge warn" id="lowBadge" style="display:none">LOW BALANCE</span> <span class="badge bad" id="faultBadge" style="display:none">PZEM FAULT</span></div>
  </section>
  <section class="card">
    <h2>Live readings</h2>
    <div class="row"><span>Voltage</span><span id="v">--</span></div>
    <div class="row"><span>Current</span><span id="i">--</span></div>
    <div class="row"><span>Power</span><span id="p">--</span></div>
    <div class="row"><span>Energy</span><span id="e">--</span></div>
    <div class="row"><span>Frequency</span><span id="f">--</span></div>
    <div class="row"><span>Power factor</span><span id="pf">--</span></div>
  </section>
  <section class="card">
    <h2>Billing</h2>
    <div class="row"><span>Cycle units</span><span id="cycle">--</span></div>
    <div class="row"><span>Tariff version</span><span id="tver">--</span></div>
    <div class="row"><span>Last recharge #</span><span id="rc">--</span></div>
    <table style="margin-top:10px"><thead><tr><th>Slab</th><th>Up to</th><th>Rate</th></tr></thead><tbody id="slabs"><tr><td colspan="3">No tariff loaded - tap the card once.</td></tr></tbody></table>
  </section>
  <section class="card">
    <h2>System</h2>
    <div class="row"><span>PZEM</span><span id="pz">--</span></div>
    <div class="row"><span>NFC reader</span><span id="nfc">--</span></div>
    <div class="row"><span>Network</span><span id="net">--</span></div>
    <div class="row"><span>Uptime</span><span id="up">--</span></div>
  </section>
  <section class="card">
    <h2>Operate</h2>
    <label for="pw">Admin password</label>
    <input id="pw" type="password" autocomplete="current-password">
    <label for="amount">Reset balance to (Rs)</label>
    <input id="amount" type="number" min="0" max="99999.99" step="0.01" value="0">
    <button class="danger" id="btnBal">Reset balance</button>
    <button id="btnCycle">Reset billing cycle</button>
    <div id="msg"></div>
    <div class="note">A balance of Rs 0 cuts the relay immediately. Recharge history is untouched, so an already-used card can't be credited again.</div>
  </section>
</div>
</main>
<script>
function $(id){return document.getElementById(id);}
function set(id,t){$(id).textContent=t;}
function num(v,d,u){return (v===undefined||v===null)?'--':v.toFixed(d)+(u?' '+u:'');}
function rs(p){return 'Rs '+(p/100).toFixed(2);}
function upTime(s){var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return (d?d+'d ':'')+h+'h '+m+'m';}
function online(on){$('dot').className='dot'+(on?' on':'');set('connTxt',on?'live':'meter not reachable');}
function badge(id,txt,cls){var b=$(id);b.textContent=txt;b.className='badge '+cls;}

function render(s){
  set('balance',rs(s.balancePaise));
  $('balanceCard').className='card hero'+(s.balancePaise===0?' bad':(s.lowBalance?' warn':''));
  badge('relayBadge',s.relayEngaged?'POWER ON':'POWER CUT',s.relayEngaged?'ok':'bad');
  $('lowBadge').style.display=s.lowBalance?'inline-block':'none';
  $('faultBadge').style.display=s.pzemFaultCutoff?'inline-block':'none';
  set('v',num(s.voltageV,1,'V'));
  set('i',num(s.currentA,3,'A'));
  set('p',num(s.powerW,1,'W'));
  set('e',num(s.energyKwh,3,'kWh'));
  set('f',num(s.frequencyHz,1,'Hz'));
  set('pf',num(s.powerFactor,2,''));
  set('cycle',s.cycleUnitsConsumed.toFixed(3)+' units');
  set('tver',s.tariffVersion?'v'+s.tariffVersion:'not loaded');
  set('rc','#'+s.lastAppliedRechargeCounter);
  set('pz',s.pzemOk?'OK':'not responding');
  set('nfc',s.nfcAvailable?'OK':'not responding');
  set('net',(s.wifiMode==='AP'?'Hotspot ':'Wi-Fi ')+s.ip);
  set('up',upTime(s.uptimeS));
  var tb=$('slabs');
  tb.textContent='';
  if(!s.tariffSlabs||!s.tariffSlabs.length){
    var r=tb.insertRow();var c=r.insertCell();c.colSpan=3;c.textContent='No tariff loaded - tap the card once.';
  }else{
    s.tariffSlabs.forEach(function(sl,n){
      var r=tb.insertRow();
      r.insertCell().textContent=n+1;
      r.insertCell().textContent=sl.unbounded?'above':sl.upToUnits+' units';
      r.insertCell().textContent='Rs '+(sl.ratePaise/100).toFixed(2)+'/unit';
    });
  }
}

function poll(){
  fetch('/api/status',{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(s){render(s);online(true);})
    .catch(function(){online(false);});
}
setInterval(poll,2000);poll();

function msg(t,bad){var m=$('msg');m.textContent=t;m.className=bad?'err':'good';}

function post(path,body){
  var pass=$('pw').value;
  if(!pass){msg('Enter the admin password first.',true);return;}
  var auth='Basic '+btoa(unescape(encodeURIComponent('admin:'+pass)));
  $('btnBal').disabled=$('btnCycle').disabled=true;
  fetch(path,{method:'POST',headers:{'Authorization':auth,'Content-Type':'application/x-www-form-urlencoded'},body:body})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
    .then(function(x){if(x.ok){msg('Done.',false);render(x.j);}else{msg(x.j.error||'Failed.',true);}})
    .catch(function(){msg('Meter not reachable.',true);})
    .then(function(){$('btnBal').disabled=$('btnCycle').disabled=false;});
}

$('btnBal').onclick=function(){
  var a=$('amount').value.trim();if(a==='')a='0';
  var n=Number(a);
  if(isNaN(n)||n<0||n>99999.99){msg('Amount must be between 0 and 99999.99.',true);return;}
  var q='Set balance to Rs '+n.toFixed(2)+'?'+(n===0?' The relay will cut power immediately.':'');
  if(confirm(q))post('/api/reset-balance','amount='+encodeURIComponent(a));
};
$('btnCycle').onclick=function(){
  if(confirm('Reset the billing cycle? Cycle units go back to 0 and billing restarts from the first slab.'))post('/api/reset-cycle','');
};
</script>
</body>
</html>
)rawliteral";
