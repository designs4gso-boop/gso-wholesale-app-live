(function(){
function q(r,s){return r.querySelector(s)}
function m(v){return "$"+Number(v||0).toFixed(2)}
function c(v){return String(v||"").trim()}
function e(v){return String(v||"").replace(/[&<>"']/g,function(x){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[x]})}
function id(g){var p=String(g||"").split("/");return p[p.length-1]||""}
function opts(a,s){return(a||[]).map(function(v){v=String(v||"");return'<option value="'+e(v)+'"'+(v===s?" selected":"")+">"+e(v)+"</option>"}).join("")}
function form(r){return r.closest("product-info")?.querySelector('form[action*="/cart/add"]')||r.closest("section")?.querySelector('form[action*="/cart/add"]')||document.querySelector('form[action*="/cart/add"]')}
function hid(f,n){var i=f.querySelector('input[name="'+n+'"]');if(!i){i=document.createElement("input");i.type="hidden";i.name=n;f.appendChild(i)}return i}
function sync(r,s,p){
 var f=form(r); if(!f||!p||!p.active)return;
 var v=id((p.product&&p.product.shopifyVariantGid)||r.getAttribute("data-base-variant-gid"));
 if(v){var ii=f.querySelector('input[name="id"],select[name="id"]'); if(ii){ii.value=v;ii.dispatchEvent(new Event("change",{bubbles:true}))}else hid(f,"id").value=v}
 var qi=f.querySelector('input[name="quantity"]'); if(qi){qi.value=String(s.quantity);qi.dispatchEvent(new Event("change",{bubbles:true}))}else hid(f,"quantity").value=String(s.quantity);
 hid(f,"properties[Material]").value=s.material;
 hid(f,"properties[Finish]").value=s.finish;
 hid(f,"properties[Bag Color]").value=s.bagColor;
 hid(f,"properties[Sides]").value=(p.product&&p.product.defaultSides)||"Double Sided";
 hid(f,"properties[ERP Product ID]").value=(p.product&&p.product.id)||"";
 hid(f,"properties[ERP Product Type]").value="4x5 Stock Bag";
 hid(f,"properties[ERP Price Each]").value=m(p.pricing&&p.pricing.priceEach);
 hid(f,"properties[ERP Matched Tier]").value=(p.pricing&&p.pricing.matchedRange)||"";
 hid(f,"properties[_gso_configurator]").value="true";
}
function styles(){
 if(document.getElementById("gso-configurator-runtime-styles"))return;
 var s=document.createElement("style");
 s.id="gso-configurator-runtime-styles";
 s.textContent=[
  ".gso-configurator select{",
  " color:var(--gso-config-text,#fff)!important;",
  " background:var(--gso-config-field-bg,#050505)!important;",
  " -webkit-text-fill-color:var(--gso-config-text,#fff)!important;",
  " opacity:1!important;",
  " visibility:visible!important;",
  " appearance:auto!important;",
  "}",
  ".gso-configurator select option{",
  " color:#111!important;",
  " background:#fff!important;",
  " -webkit-text-fill-color:#111!important;",
  "}",
  ".gso-configurator input{",
  " color:var(--gso-config-text,#fff)!important;",
  " background:var(--gso-config-field-bg,#050505)!important;",
  " -webkit-text-fill-color:var(--gso-config-text,#fff)!important;",
  " opacity:1!important;",
  "}",
  ".gso-configurator [hidden]{display:none!important;}"
 ].join("");
 document.head.appendChild(s);
}
function init(r){
 styles();
 if(!r||r.dataset.gsoReady==="true")return; r.dataset.gsoReady="true";
 var min=Math.max(parseInt(r.dataset.minimumQuantity||"64",10)||64,1), st={material:"",finish:"",bagColor:"",quantity:min}, last=null, first=true;
 var els={load:q(r,".gso-configurator__loading"),app:q(r,".gso-configurator__app"),err:q(r,".gso-configurator__error"),mat:q(r,'[data-gso-field="material"]'),fin:q(r,'[data-gso-field="finish"]'),col:q(r,'[data-gso-field="bagColor"]'),qty:q(r,'[data-gso-field="quantity"]')};
 if(!els.mat||!els.fin||!els.col||!els.qty)return;
 els.qty.min=String(min); els.qty.value=String(min);
 function set(k,v){var x=q(r,'[data-gso-result="'+k+'"]'); if(x)x.textContent=v}
 function show(k,on){var x=q(r,'[data-gso-result="'+k+'"]'); if(x)x.hidden=!on}
 function fail(t){if(els.load)els.load.hidden=true;if(els.app)els.app.hidden=true;if(els.err){els.err.hidden=false;els.err.textContent=t||"Unable to load configurator."}}
 function url(){
  var p=new URLSearchParams(), proxy=r.dataset.configuratorProxy||"/apps/wholesale-lite/configurator";
  [["shop",r.dataset.shop],["handle",r.dataset.productHandle],["productGid",r.dataset.productGid],["material",st.material],["finish",st.finish],["bagColor",st.bagColor]].forEach(function(a){if(c(a[1]))p.set(a[0],c(a[1]))});
  p.set("quantity",String(st.quantity||min)); return proxy+"?"+p.toString()
 }
 function breaks(rows){
  var box=q(r,'[data-gso-result="priceBreaksBox"]'), body=q(r,'[data-gso-result="priceBreaks"]'), on=r.dataset.showPriceBreaks!=="false";
  if(!box||!body)return; box.hidden=!(on&&rows&&rows.length);
  body.innerHTML=(rows||[]).map(function(x){return'<div><span>'+e(x.range)+'</span><strong>'+m(x.priceEach)+' each</strong></div>'}).join("")
 }
 function render(p){
  last=p; if(!p||!p.ok||!p.active){fail((p&&p.message)||"This product is not connected to the GSO configurator yet.");return}
  var o=p.options||{}, sel=p.selected||{}, pr=p.pricing||{}, prod=p.product||{};
  st.material=sel.material||st.material||(o.materials||[])[0]||"";
  st.finish=sel.finish||st.finish||(o.finishes||[])[0]||"";
  st.bagColor=sel.bagColor||st.bagColor||(o.bagColors||[])[0]||"";
  st.quantity=Math.max(parseInt(sel.quantity||els.qty.value||min,10)||min,Number(prod.minQuantity||min));
  els.mat.innerHTML=opts(o.materials,st.material); els.fin.innerHTML=opts(o.finishes,st.finish); els.col.innerHTML=opts(o.bagColors,st.bagColor); els.qty.value=String(st.quantity); els.qty.min=String(prod.minQuantity||min);
  show("priceEachBox",r.dataset.showPriceEach!=="false"); show("orderTotalBox",r.dataset.showOrderTotal==="true"); show("matchedTierBox",r.dataset.showMatchedTier==="true"); show("internalBox",r.dataset.showProfitData==="true");
  set("priceEach",m(pr.priceEach)); set("orderTotal",m(pr.orderTotal)); set("matchedTier",pr.matchedRange||"No match"); set("costEach",m(pr.costEach)); set("margin",Number(pr.margin||0).toFixed(1)+"%");
  var n=q(r,'[data-gso-result="notice"]'); if(n)n.textContent="Sides are set to "+(prod.defaultSides||"Double Sided")+". Minimum order is "+(prod.minQuantity||min)+" units.";
  breaks(pr.priceBreaks||[]);
  if(els.load)els.load.hidden=true; if(els.err)els.err.hidden=true; if(els.app)els.app.hidden=false;
  sync(r,st,p); if(first){first=false;r.dispatchEvent(new CustomEvent("gso:configurator:ready",{bubbles:true,detail:p}))}
 }
 function go(){if(els.load&&first)els.load.hidden=false;fetch(url(),{credentials:"same-origin"}).then(function(x){return x.json()}).then(render).catch(function(){fail("Unable to load GSO configurator pricing.")})}
 function upd(){st.material=els.mat.value||st.material;st.finish=els.fin.value||st.finish;st.bagColor=els.col.value||st.bagColor;st.quantity=Math.max(parseInt(els.qty.value||min,10)||min,min);go()}
 ["change","input"].forEach(function(ev){els.qty.addEventListener(ev,upd)}); els.mat.addEventListener("change",upd); els.fin.addEventListener("change",upd); els.col.addEventListener("change",upd);
 var f=form(r); if(f)f.addEventListener("submit",function(){if(last)sync(r,st,last)});
 go()
}
function all(){document.querySelectorAll(".gso-configurator").forEach(init)}
document.addEventListener("DOMContentLoaded",all);document.addEventListener("shopify:section:load",all);document.addEventListener("shopify:block:select",all);window.GSOProductConfiguratorInit=all;
})();


