import http from "node:http";
const many = Array.from({ length: 160 }, (_, i) => `<li><a href="/item/${i}">Item number ${i}</a></li>`).join("");
const pages = {
  "/": `<!doctype html><title>Home Page</title><body style="margin:0">
<h1>Shop Home</h1>
<nav><a href="/about">About us</a> <a href="/many">All items</a> <a target="_blank" href="/popup">Open help (new tab)</a></nav>
<div id="menu" style="cursor:pointer;padding:8px;border:1px solid #999" onclick="document.getElementById('sub').style.display='block'">Menu (div onclick)</div>
<div id="sub" style="display:none"><a href="/deep">Deep link</a></div>
<div role="tab" tabindex="0" style="padding:6px">Tab Reviews (role=tab)</div>
<span contenteditable="true" id="ce" style="display:inline-block;min-width:100px;border:1px solid #000">editable</span>
<form action="/search" method="get"><input name="q" placeholder="Search products"><button type="submit">Go</button></form>
<select id="sel" name="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select>
<button id="late-btn" style="display:none">Late button</button>
<script>setTimeout(()=>{document.getElementById('late-btn').style.display='inline-block'},1200)</script>
<div id="cookie" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999;display:flex;align-items:center;justify-content:center"><div style="background:#fff;padding:20px"><p>We use cookies</p><button id="accept" onclick="document.getElementById('cookie').remove()">Accept all cookies</button></div></div>
</body>`,
  "/about": `<!doctype html><title>About</title><h1>About us</h1><p>We sell things since 1999.</p><a href="/">Back home</a>`,
  "/popup": `<!doctype html><title>Help Popup</title><h1>Help center</h1><p>Call us at 123.</p>`,
  "/deep": `<!doctype html><title>Deep</title><h1>Deep page</h1>`,
  "/many": `<!doctype html><title>Many</title><h1>All items</h1><button id="top-btn">Top Action</button><ul>${many}</ul><button id="bottom-btn">Bottom Action</button>`,
  "/search": `<!doctype html><title>Search results</title><h1>Results</h1><p>Search worked</p>`,
  "/article": `<!doctype html><html><head><title>Great Article</title><meta name="description" content="An article about testing."><style>.x{color:red}</style><script>var junk=1</script></head><body><nav>menu junk</nav><article><h1>Great Article</h1><p>First paragraph with <a href="/rel/link">relative link</a> and &amp; entity &#1593;.</p><p>${"Body text. ".repeat(80)}</p></article><footer>footer junk</footer></body></html>`,
  "/spa": `<!doctype html><title>SPA</title><div id="app"></div><noscript>enable js</noscript><script>document.getElementById('app').textContent='';</script>`,
};
export function start() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/json") { rsp.writeHead(200, { "content-type": "application/json" }); return rsp.end('{"a":1,"b":[1,2]}'); }
      if (u.pathname === "/redir-private") { rsp.writeHead(302, { location: "http://127.0.0.1:1/secret" }); return rsp.end(); }
      if (u.pathname === "/pdf") { rsp.writeHead(200, { "content-type": "application/pdf" }); return rsp.end("%PDF-1.4"); }
      const body = pages[u.pathname];
      if (!body) { rsp.writeHead(404); return rsp.end("nf"); }
      rsp.writeHead(200, { "content-type": "text/html; charset=utf-8" }); rsp.end(body);
    }).listen(0, "127.0.0.1", () => res({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
