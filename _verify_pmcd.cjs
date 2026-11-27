const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const DIST = path.resolve("dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png"
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let fp = path.join(DIST, urlPath === "/" ? "index.html" : urlPath);
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    fp = path.join(DIST, "index.html");
  }
  const ext = path.extname(fp);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(fp).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.error("Server listening on", port);
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const errors = [];
  const pushErr = (msg) => { console.error("ERR:", msg); errors.push(msg); };
  try {
    for (const file of ["andamento-quarteiroes.html", "andamento-quarteiroes-liraa.html"]) {
      console.error("Testing", file);
      const page = await browser.newPage();
      page.on("pageerror", e => pushErr(file + " pageerror: " + e.message));
      page.on("dialog", async d => {
        pushErr(file + " unexpected dialog: " + d.message());
        await d.dismiss();
      });
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${baseUrl}/${file}`, { waitUntil: "load", timeout: 30000 });
      await page.waitForFunction(() => typeof window.trocarAba === "function" && typeof window.gerarPDF === "function", { timeout: 15000 });
      await new Promise(r => setTimeout(r, 250));

      await page.evaluate(() => {
        if (typeof dadosFormularios === "object") {
          for (const tipo of ["andamento", "concluidos", "resumo", "bases", "basesliraa", "coflagrados", "resumogeral"]) {
            if (!dadosFormularios[tipo]) dadosFormularios[tipo] = {};
            dadosFormularios[tipo]["0_1_0"] = { q: "101", r: "12", c: "2", tb: "1", pe: "0", o: "1" };
            dadosFormularios[tipo]["0_2_0"] = { q: "133", r: "15", c: "3", tb: "0", pe: "1", o: "0" };
          }
        }
        const q1 = document.getElementById("q-1-0-0");
        const r1 = document.getElementById("r-1-0-0");
        const ag1 = document.getElementById("ag-1-0-0");
        if (q1 && r1 && ag1) { ag1.value = "Agente Teste"; q1.value = "101"; r1.value = "25"; if (typeof recalcular === "function") recalcular(); }
        document.querySelectorAll("table.tabela-identificacao input").forEach((inp, idx) => {
          if (idx % 2 === 0 && !inp.value) inp.value = "Texto Longo de Teste para Validacao";
        });
      });

      const tabs = file === "andamento-quarteiroes.html"
        ? ["andamento", "concluidos", "resumo", "bases", "basesliraa", "coflagrados", "resumogeral", "boletins", "semanal", "total", "informados"]
        : ["andamento", "concluidos", "resumo", "boletins", "semanal", "total", "informados"];
      const tabsWithHeader = tabs.filter(t => !["boletins", "semanal", "total", "informados"].includes(t));

      for (const vpWidth of [1280, 960, 860]) {
        await page.setViewport({ width: vpWidth, height: 900 });
        for (const t of tabsWithHeader) {
          await page.evaluate((tab) => { trocarAba(tab); }, t);
          await new Promise(r => setTimeout(r, 30));
          const check = await page.evaluate((tab) => {
            const p = document.getElementById("painel-" + tab);
            const hdr = p.querySelector("table.tabela-identificacao");
            const dupla = p.querySelector(".dupla-tabelas");
            const tables = Array.from(p.querySelectorAll(".tabela-dupla table"));
            const hRect = hdr ? hdr.getBoundingClientRect() : null;
            const dRect = dupla ? dupla.getBoundingClientRect() : null;
            return {
              hdrW: hRect ? Math.round(hRect.width) : 0,
              duplaW: dRect ? Math.round(dRect.width) : 0,
              diff: hRect && dRect ? Math.round(Math.abs(hRect.width - dRect.width) * 10) / 10 : -1,
              tblOverflow: tables.map(tb => Math.max(0, tb.scrollWidth - tb.clientWidth))
            };
          }, t);
          if (check.diff > 3 || check.tblOverflow.some(o => o > 2)) {
            pushErr(`${file} @${vpWidth}px tab=${t}: ${JSON.stringify(check)}`);
          }
        }
      }

      await page.setViewport({ width: 390, height: 844 });
      for (const t of tabsWithHeader) {
        await page.evaluate((tab) => { trocarAba(tab); }, t);
        await new Promise(r => setTimeout(r, 25));
        const mobCheck = await page.evaluate(() => ({
          docOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
        }));
        if (mobCheck.docOverflow > 4) {
          pushErr(`${file} @390px tab=${t} docOverflow=${mobCheck.docOverflow}`);
        }
      }
      console.error(file, "screen + mobile OK");

      // Print checks
      await page.setViewport({ width: 1280, height: 900 });
      for (const t of ["andamento", "basesliraa", "semanal", "total", "informados"]) {
        if (!tabs.includes(t)) continue;
        await page.evaluate((tab) => { trocarAba(tab); }, t);
        await page.emulateMediaType("print");
        await new Promise(r => setTimeout(r, 30));
        const printCheck = await page.evaluate((tab) => {
          const p = document.getElementById("painel-" + tab);
          const hdr = p.querySelector("table.tabela-identificacao");
          const dupla = p.querySelector(".dupla-tabelas");
          const st = document.getElementById("pmcd-print-page-style")?.textContent || "";
          const hW = hdr ? hdr.getBoundingClientRect().width : 0;
          const dW = dupla ? dupla.getBoundingClientRect().width : 0;
          return {
            orientStyle: st,
            hW: Math.round(hW),
            dW: Math.round(dW),
            diff: hdr && dupla ? Math.round(Math.abs(hW - dW)) : 0,
            docOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
          };
        }, t);
        const pdfBytes = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });
        await page.emulateMediaType("screen");
        if (printCheck.diff > 3 || printCheck.docOverflow > 4 || pdfBytes.length < 1000) {
          pushErr(`${file} PRINT tab=${t}: ${JSON.stringify(printCheck)} pdfBytes=${pdfBytes.length}`);
        }
      }
      console.error(file, "print A4 OK");

      // Wrap criarDocumentoJsPDF cleanly WITHOUT mutating jsPDF.prototype
      await page.evaluate(() => {
        window.__savedPdfs = [];
        const origCriar = window.criarDocumentoJsPDF;
        window.criarDocumentoJsPDF = async function(orient) {
          const doc = await origCriar.call(this, orient);
          doc.save = function(name) {
            window.__savedPdfs.push({
              name,
              pages: this.internal.pages.length - 1,
              w: Math.round(this.internal.pageSize.getWidth()),
              h: Math.round(this.internal.pageSize.getHeight())
            });
            return this;
          };
          return doc;
        };
      });

      const pdfTabs = file === "andamento-quarteiroes.html"
        ? ["andamento", "basesliraa", "resumo", "semanal", "total"]
        : ["andamento", "resumo", "semanal", "total"];
      for (const t of pdfTabs) {
        await page.evaluate((tab) => { trocarAba(tab); }, t);
        await page.evaluate(async (tab) => { await gerarPDF(tab); }, t);
      }
      const savedPdfs = await page.evaluate(() => window.__savedPdfs);
      console.error(file, "PDFs:", JSON.stringify(savedPdfs));
      if (savedPdfs.length < pdfTabs.length) pushErr(file + " missing PDFs: " + JSON.stringify(savedPdfs));
      for (const sp of savedPdfs) {
        if (sp.pages < 1) pushErr(`${file} PDF ${sp.name} had 0 pages`);
        const isLand = sp.name.startsWith("total_") || sp.name.startsWith("informados_");
        if (isLand && (sp.w !== 297 || sp.h !== 210)) pushErr(`${file} PDF ${sp.name} wrong landscape size ${sp.w}x${sp.h}`);
        if (!isLand && (sp.w !== 210 || sp.h !== 297)) pushErr(`${file} PDF ${sp.name} wrong portrait size ${sp.w}x${sp.h}`);
      }
      await page.close();
    }

    // Index.html verification
    console.error("Testing index.html");
    {
      const page = await browser.newPage();
      page.on("pageerror", e => pushErr("index.html pageerror: " + e.message));
      page.on("dialog", async d => {
        pushErr("index.html unexpected dialog: " + d.message());
        await d.dismiss();
      });
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`${baseUrl}/index.html`, { waitUntil: "load", timeout: 30000 });
      await page.waitForFunction(() => typeof window._alternarAbaSistema === "function", { timeout: 15000 });
      await new Promise(r => setTimeout(r, 300));

      // Wrap window.jspdf.jsPDF constructor cleanly without touching prototype
      await page.evaluate(() => {
        window.__savedPdfs = [];
        if (window.jspdf && window.jspdf.jsPDF) {
          const Orig = window.jspdf.jsPDF;
          window.jspdf.jsPDF = function(...args) {
            const inst = new Orig(...args);
            inst.save = function(name) {
              window.__savedPdfs.push({
                name,
                pages: this.internal.pages.length - 1,
                w: Math.round(this.internal.pageSize.getWidth()),
                h: Math.round(this.internal.pageSize.getHeight())
              });
              return this;
            };
            return inst;
          };
        }
        document.body.classList.remove("autenticacao-pendente", "atividade-pendente");
        ["telaAberturaAnimada", "telaLoginSistema", "telaEscolhaAtividade"].forEach(id => {
          const el = document.getElementById(id);
          if (el) { el.classList.remove("ativo"); el.style.display = "none"; }
        });
      });

      // Switch to LIRAa activity via #btnEscolherLiraa so quarteiroes-liraa is unlocked
      await page.evaluate(() => {
        const btnL = document.getElementById("btnEscolherLiraa");
        if (btnL) btnL.click();
        document.body.classList.remove("autenticacao-pendente", "atividade-pendente");
        const telaEsc = document.getElementById("telaEscolhaAtividade");
        if (telaEsc) { telaEsc.classList.remove("ativo"); telaEsc.style.display = "none"; }
        window._alternarAbaSistema("quarteiroes-liraa");
      });
      await new Promise(r => setTimeout(r, 200));

      const qlCheck = await page.evaluate(() => {
        const sec = document.getElementById("aba-quarteiroes-liraa");
        const folhas = Array.from(sec.querySelectorAll(".folha-a4"));
        const hdr = folhas[0].querySelector("table.tabela-identificacao");
        const grid = folhas[0].querySelector(".grid-duplo");
        const colSums = ["tabela-1", "tabela-2", "tabela-3", "tabela-4"].map(id => {
          const cols = Array.from(document.querySelectorAll(`#${id} colgroup col`));
          return cols.reduce((acc, c) => acc + parseFloat(c.style.width || "0"), 0);
        });
        return {
          secActive: sec.classList.contains("ativo"),
          hdrW: Math.round(hdr.getBoundingClientRect().width),
          gridW: Math.round(grid.getBoundingClientRect().width),
          diff: Math.round(Math.abs(hdr.getBoundingClientRect().width - grid.getBoundingClientRect().width)),
          colSums
        };
      });
      console.error("index.html quarteiroes-liraa screen:", JSON.stringify(qlCheck));
      if (!qlCheck.secActive || qlCheck.hdrW < 500 || qlCheck.diff > 3 || qlCheck.colSums.some(s => s !== 100)) {
        pushErr("index.html quarteiroes-liraa layout mismatch: " + JSON.stringify(qlCheck));
      }

      await page.evaluate(() => {
        const tbody = document.querySelector("#tabela-liraa tbody");
        if (tbody) {
          tbody.innerHTML = "";
          for (let i = 1; i <= 45; i++) {
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${i}</td><td>${i}</td><td>${100+i}</td><td>10</td><td>2</td><td>1</td><td>0</td><td>0</td><td>13</td><td>1</td>`;
            tbody.appendChild(tr);
          }
        }
      });
      await page.click("#btn-pdf-acao");
      await page.waitForFunction(() => window.__savedPdfs.length >= 1, { timeout: 25000 });
      console.error("index.html Quarteiroes LIRAa PDF OK");

      // Print quarteiroes-liraa
      await page.emulateMediaType("print");
      await new Promise(r => setTimeout(r, 60));
      const qlPrint = await page.evaluate(() => {
        const sec = document.getElementById("aba-quarteiroes-liraa");
        const f = sec.querySelector(".folha-a4");
        const h = f.querySelector("table.tabela-identificacao");
        const g = f.querySelector(".grid-duplo");
        return {
          hdrDiff: Math.round(Math.abs(h.getBoundingClientRect().width - g.getBoundingClientRect().width)),
          overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
        };
      });
      const qlPrintBytes = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });
      await page.emulateMediaType("screen");
      if (qlPrint.overflow > 4 || qlPrint.hdrDiff > 3 || qlPrintBytes.length < 1000) {
        pushErr("index.html PRINT quarteiroes-liraa: " + JSON.stringify(qlPrint));
      }

      // Switch to Ciclo activity for resumo-reconhecimento, relatorio-campo, resumo, ciclo, producao-individual
      await page.evaluate(() => {
        const btnC = document.getElementById("btnEscolherCiclo");
        if (btnC) btnC.click();
        document.body.classList.remove("autenticacao-pendente", "atividade-pendente");
        const telaEsc = document.getElementById("telaEscolhaAtividade");
        if (telaEsc) { telaEsc.classList.remove("ativo"); telaEsc.style.display = "none"; }
      });

      await page.evaluate(() => window._alternarAbaSistema("lancamentos"));
      await new Promise(r => setTimeout(r, 120));
      for (const dia of ["segunda", "terca", "quarta", "quinta", "sexta"]) {
        await page.evaluate((d) => {
          document.querySelector(`#abasDias .aba-dia[data-dia="${d}"]`)?.click();
        }, dia);
        await new Promise(r => setTimeout(r, 80));
        await page.evaluate(() => {
          document.querySelectorAll("#aba-lancamentos select.sup-sim-nao").forEach(sel => {
            if (!sel.value) {
              sel.value = "Não";
              sel.dispatchEvent(new Event("change", { bubbles: true }));
            }
          });
        });
        await new Promise(r => setTimeout(r, 40));
      }

      const clickPdfBtn = async (id, expectedCount) => {
        const ok = await page.evaluate((btnId) => {
          const b = document.getElementById(btnId);
          if (!b) return { found: false };
          b.scrollIntoView({ block: "center" });
          b.click();
          return { found: true, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) };
        }, id);
        if (!ok.found) throw new Error("Button not found: " + id);
        await page.waitForFunction((n) => window.__savedPdfs.length >= n, { timeout: 25000 }, expectedCount);
      };

      await page.evaluate(() => window._alternarAbaSistema("resumo-reconhecimento"));
      await new Promise(r => setTimeout(r, 120));
      await clickPdfBtn("btnImprimirPDFReconhecimento", 2);

      await page.evaluate(() => window._alternarAbaSistema("relatorio-campo"));
      await new Promise(r => setTimeout(r, 120));
      await clickPdfBtn("btnRcPDF", 3);

      await page.evaluate(() => window._alternarAbaSistema("resumo"));
      await new Promise(r => setTimeout(r, 120));
      await clickPdfBtn("btnImprimirPDF", 4);

      await page.evaluate(() => window._alternarAbaSistema("ciclo"));
      await new Promise(r => setTimeout(r, 120));
      await clickPdfBtn("btnImprimirPDFCiclo", 5);

      await page.evaluate(() => window._alternarAbaSistema("producao-individual"));
      await new Promise(r => setTimeout(r, 120));
      await clickPdfBtn("btnImprimirPDFProdInd", 6);

      const idxPdfs = await page.evaluate(() => window.__savedPdfs);
      console.error("index.html PDFs:", JSON.stringify(idxPdfs));
      const recPdf = idxPdfs.find(p => p.name.includes("Resumo_Reconhecimento"));
      if (!recPdf || recPdf.pages !== 1 || recPdf.w !== 210 || recPdf.h !== 297) {
        pushErr("index.html Resumo_Reconhecimento PDF should fit on 1 portrait A4 page: " + JSON.stringify(recPdf));
      }
      const qlPdf = idxPdfs.find(p => p.name.includes("Quarteiroes_LIRAa"));
      if (!qlPdf || qlPdf.w !== 210 || qlPdf.h !== 297 || qlPdf.pages < 3) {
        pushErr("index.html Quarteiroes_LIRAa PDF invalid: " + JSON.stringify(qlPdf));
      }
      for (const p of idxPdfs) {
        if (p.pages < 1 || !((p.w === 210 && p.h === 297) || (p.w === 297 && p.h === 210))) {
          pushErr("index.html invalid A4 PDF dimensions: " + JSON.stringify(p));
        }
      }

      for (const abaId of ["resumo-reconhecimento", "relatorio-campo", "resumo", "ciclo", "producao-individual"]) {
        await page.evaluate((id) => window._alternarAbaSistema(id), abaId);
        await page.emulateMediaType("print");
        await new Promise(r => setTimeout(r, 60));
        const pInfo = await page.evaluate(() => ({
          st: document.getElementById("pmcd-print-orientacao-style")?.textContent || "",
          overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)
        }));
        const pdfBytes = await page.pdf({ format: "A4", preferCSSPageSize: true, printBackground: true });
        await page.emulateMediaType("screen");
        if (pInfo.overflow > 4 || pdfBytes.length < 1000) {
          pushErr(`index.html PRINT aba=${abaId}: ${JSON.stringify(pInfo)} bytes=${pdfBytes.length}`);
        }
      }
      console.error("index.html print checks done");

      await page.evaluate(() => window._alternarAbaSistema("andamento-quarteiroes"));
      await new Promise(r => setTimeout(r, 1000));
      const ifrOk = await page.evaluate(() => {
        const ifr = document.getElementById("iframeAndamentoQuarteiroes");
        if (!ifr || !ifr.contentDocument) return { ok: false };
        const hdr = ifr.contentDocument.querySelector("table.tabela-identificacao");
        return { ok: true, hasImprimir: typeof ifr.contentWindow.imprimir === "function", hasHdr: !!hdr, src: ifr.getAttribute("src") };
      });
      console.error("index.html iframe check:", JSON.stringify(ifrOk));
      if (!ifrOk.ok || !ifrOk.hasImprimir) {
        pushErr("index.html iframe andamento check failed: " + JSON.stringify(ifrOk));
      }

      await page.close();
    }

    if (errors.length > 0) {
      console.error("VERIFICATION FAILURES:\n" + errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.error("ALL SCREEN, PDF, AND PRINT VERIFICATIONS PASSED!");
    }
  } finally {
    await browser.close();
    server.close();
  }
})();
