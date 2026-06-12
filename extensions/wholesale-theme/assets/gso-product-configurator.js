(function(){
var CART_KEY="gso_configurator_cart_v1";

function q(r,s){return r.querySelector(s)}
function qa(r,s){return Array.prototype.slice.call(r.querySelectorAll(s))}
function m(v){return "$"+Number(v||0).toFixed(2)}
function c(v){return String(v||"").trim()}
function e(v){return String(v||"").replace(/[&<>"']/g,function(x){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[x]})}
function id(g){var p=String(g||"").split("/");return p[p.length-1]||""}
function opts(a,s){return(a||[]).map(function(v){v=String(v||"");return'<option value="'+e(v)+'"'+(v===s?" selected":"")+">"+e(v)+"</option>"}).join("")}
function form(r){return r.closest("product-info")?.querySelector('form[action*="/cart/add"]')||r.closest("section")?.querySelector('form[action*="/cart/add"]')||document.querySelector('form[action*="/cart/add"]')}
function hid(f,n){var i=f.querySelector('input[name="'+n+'"]');if(!i){i=document.createElement("input");i.type="hidden";i.name=n;f.appendChild(i)}return i}

function readCart(){
 try{return JSON.parse(localStorage.getItem(CART_KEY)||"[]")||[]}catch(err){return[]}
}
function writeCart(items){
 localStorage.setItem(CART_KEY,JSON.stringify(items||[]));
 updateCartButton();
}
function cartCount(){
 return readCart().reduce(function(sum,item){return sum+(Number(item.quantity)||0)},0)
}
function cartSubtotal(){
 return readCart().reduce(function(sum,item){return sum+(Number(item.orderTotal)||0)},0)
}
function itemKey(item){
 return [
  item.shop||"",
  item.handle||"",
  item.material||"",
  item.finish||"",
  item.bagColor||""
 ].join("||");
}

function ensureCartStyles(){
 if(document.getElementById("gso-cart-runtime-styles"))return;
 var s=document.createElement("style");
 s.id="gso-cart-runtime-styles";
 s.textContent=[
  ".gso-cart-fab{position:fixed;right:18px;bottom:18px;z-index:999999;background:#050505;color:#fff;border:1px solid #ff1f1f;border-radius:999px;padding:12px 18px;font-weight:800;letter-spacing:.04em;box-shadow:0 8px 30px rgba(0,0,0,.35);cursor:pointer}",
  ".gso-cart-fab span{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;margin-left:8px;background:#ff1f1f;color:#fff;border-radius:999px;font-size:12px}",
  ".gso-cart-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999998;opacity:0;pointer-events:none;transition:.2s ease}",
  ".gso-cart-backdrop.is-open{opacity:1;pointer-events:auto}",
  ".gso-cart-drawer{position:fixed;top:0;right:0;height:100vh;width:min(460px,92vw);z-index:999999;background:#07070d;color:#fff;border-left:1px solid #ff1f1f;box-shadow:-20px 0 60px rgba(0,0,0,.45);transform:translateX(105%);transition:.25s ease;display:flex;flex-direction:column;font-family:inherit}",
  ".gso-cart-drawer.is-open{transform:translateX(0)}",
  ".gso-cart-head{display:flex;align-items:center;justify-content:space-between;padding:20px;border-bottom:1px solid rgba(255,255,255,.12)}",
  ".gso-cart-title{font-size:22px;font-weight:900;letter-spacing:.04em;margin:0}",
  ".gso-cart-close{background:transparent;color:#fff;border:0;font-size:30px;line-height:1;cursor:pointer}",
  ".gso-cart-body{padding:16px 20px;overflow:auto;flex:1}",
  ".gso-cart-empty{padding:28px 0;color:rgba(255,255,255,.7)}",
  ".gso-cart-item{display:grid;grid-template-columns:64px 1fr auto;gap:12px;padding:14px 0;border-bottom:1px solid rgba(255,255,255,.1)}",
  ".gso-cart-img{width:64px;height:64px;border-radius:10px;object-fit:cover;background:#111}",
  ".gso-cart-name{font-weight:900;margin-bottom:5px}",
  ".gso-cart-meta{font-size:12px;color:rgba(255,255,255,.75);line-height:1.45}",
  ".gso-cart-money{text-align:right;font-weight:900;white-space:nowrap}",
  ".gso-cart-remove{margin-top:10px;background:transparent;border:0;color:#ff7676;text-decoration:underline;cursor:pointer;padding:0;font-size:12px}",
  ".gso-cart-foot{padding:18px 20px;border-top:1px solid rgba(255,255,255,.12)}",
  ".gso-cart-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;font-size:16px;font-weight:900}",
  ".gso-cart-checkout{width:100%;background:#ff1f1f;color:#fff;border:0;border-radius:999px;padding:15px 18px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}",
  ".gso-cart-checkout[disabled]{opacity:.55;cursor:not-allowed}",
  ".gso-cart-clear{width:100%;margin-top:10px;background:transparent;color:rgba(255,255,255,.75);border:0;text-decoration:underline;cursor:pointer}",
  ".gso-configurator select{color:var(--gso-config-text,#fff)!important;background:var(--gso-config-field-bg,#050505)!important;-webkit-text-fill-color:var(--gso-config-text,#fff)!important;opacity:1!important;visibility:visible!important;appearance:auto!important}",
  ".gso-configurator select option{color:#111!important;background:#fff!important;-webkit-text-fill-color:#111!important}",
  ".gso-configurator input{color:var(--gso-config-text,#fff)!important;background:var(--gso-config-field-bg,#050505)!important;-webkit-text-fill-color:var(--gso-config-text,#fff)!important;opacity:1!important}",
  ".gso-configurator [hidden]{display:none!important}"
 ].join("");
 document.head.appendChild(s);
}

function ensureCart(){
 ensureCartStyles();
 if(document.getElementById("gso-cart-drawer"))return;

 var b=document.createElement("button");
 b.type="button";
 b.className="gso-cart-fab";
 b.id="gso-cart-fab";
 b.innerHTML='GSO Cart <span data-gso-cart-count>0</span>';
 b.addEventListener("click",openCart);

 var backdrop=document.createElement("div");
 backdrop.className="gso-cart-backdrop";
 backdrop.id="gso-cart-backdrop";
 backdrop.addEventListener("click",closeCart);

 var drawer=document.createElement("aside");
 drawer.className="gso-cart-drawer";
 drawer.id="gso-cart-drawer";
 drawer.setAttribute("aria-hidden","true");
 drawer.innerHTML=[
  '<div class="gso-cart-head">',
    '<h3 class="gso-cart-title">YOUR CART</h3>',
    '<button type="button" class="gso-cart-close" data-gso-cart-close aria-label="Close cart">×</button>',
  '</div>',
  '<div class="gso-cart-body" data-gso-cart-items></div>',
  '<div class="gso-cart-foot">',
    '<div class="gso-cart-row"><span>Subtotal</span><strong data-gso-cart-subtotal>$0.00</strong></div>',
    '<button type="button" class="gso-cart-checkout" data-gso-cart-checkout>Checkout</button>',
    '<button type="button" class="gso-cart-clear" data-gso-cart-clear>Clear cart</button>',
  '</div>'
 ].join("");

 document.body.appendChild(b);
 document.body.appendChild(backdrop);
 document.body.appendChild(drawer);

 q(drawer,"[data-gso-cart-close]").addEventListener("click",closeCart);
 q(drawer,"[data-gso-cart-clear]").addEventListener("click",function(){
  writeCart([]);
  renderCart();
 });
 q(drawer,"[data-gso-cart-checkout]").addEventListener("click",checkoutCart);

 renderCart();
 updateCartButton();
}

function openCart(){
 ensureCart();
 renderCart();
 q(document,"#gso-cart-backdrop").classList.add("is-open");
 q(document,"#gso-cart-drawer").classList.add("is-open");
 q(document,"#gso-cart-drawer").setAttribute("aria-hidden","false");
}
function closeCart(){
 var b=q(document,"#gso-cart-backdrop"), d=q(document,"#gso-cart-drawer");
 if(b)b.classList.remove("is-open");
 if(d){d.classList.remove("is-open");d.setAttribute("aria-hidden","true")}
}
function updateCartButton(){
 var el=q(document,"[data-gso-cart-count]");
 if(el)el.textContent=String(cartCount());
}

function renderCart(){
 ensureCartStyles();
 var drawer=q(document,"#gso-cart-drawer");
 if(!drawer)return;
 var items=readCart();
 var body=q(drawer,"[data-gso-cart-items]");
 var sub=q(drawer,"[data-gso-cart-subtotal]");
 var btn=q(drawer,"[data-gso-cart-checkout]");

 if(sub)sub.textContent=m(cartSubtotal());
 if(btn)btn.disabled=!items.length;

 if(!items.length){
  body.innerHTML='<div class="gso-cart-empty">YOUR CART is empty.</div>';
  return;
 }

 body.innerHTML=items.map(function(item,idx){
  return [
   '<div class="gso-cart-item" data-gso-cart-index="'+idx+'">',
    '<img class="gso-cart-img" src="'+e(item.image||"")+'" alt="">',
    '<div>',
      '<div class="gso-cart-name">'+e(item.title||"Configured Stock Bag")+'</div>',
      '<div class="gso-cart-meta">',
        'Material: '+e(item.material||"")+'<br>',
        'Finish: '+e(item.finish||"")+'<br>',
        'Bag Color: '+e(item.bagColor||"")+'<br>',
        'Sides: '+e(item.sides||"Double Sided")+'<br>',
        'Qty: '+e(item.quantity||"")+' × '+e(m(item.priceEach)),
      '</div>',
      '<button type="button" class="gso-cart-remove" data-gso-remove="'+idx+'">Remove</button>',
    '</div>',
    '<div class="gso-cart-money">'+e(m(item.orderTotal))+'</div>',
   '</div>'
  ].join("");
 }).join("");

 qa(body,"[data-gso-remove]").forEach(function(btn){
  btn.addEventListener("click",function(){
   var idx=Number(btn.getAttribute("data-gso-remove"));
   var next=readCart();
   next.splice(idx,1);
   writeCart(next);
   renderCart();
  });
 });
}

function addCartItem(item){
 var items=readCart();
 var key=itemKey(item);
 var existing=items.find(function(x){return itemKey(x)===key});
 if(existing){
  existing.quantity=Number(existing.quantity||0)+Number(item.quantity||0);
  existing.orderTotal=Number(existing.quantity||0)*Number(existing.priceEach||0);
 }else{
  items.push(item);
 }
 writeCart(items);
 renderCart();
 openCart();
}

function checkoutCart(){
 var items=readCart();
 if(!items.length)return;

 var drawer=q(document,"#gso-cart-drawer");
 var btn=drawer?q(drawer,"[data-gso-cart-checkout]"):null;
 var oldText=btn?btn.textContent:"";
 if(btn){btn.disabled=true;btn.textContent="Creating checkout..."}

 var first=items[0]||{};
 var proxy=first.checkoutProxy||"/apps/wholesale-lite/configurator-checkout";
 var payload={
  shop:first.shop||"",
  items:items.map(function(item){
   return {
    shop:item.shop||first.shop||"",
    handle:item.handle||"",
    productGid:item.productGid||"",
    material:item.material||"",
    finish:item.finish||"",
    bagColor:item.bagColor||"",
    quantity:Number(item.quantity||0),
    email:item.email||""
   };
  })
 };

 fetch(proxy,{
  method:"POST",
  credentials:"same-origin",
  headers:{"Content-Type":"application/json"},
  body:JSON.stringify(payload)
 }).then(function(x){return x.json()}).then(function(x){
  if(!x||!x.ok||!x.invoiceUrl)throw new Error((x&&x.error)||"Unable to create checkout.");
  writeCart([]);
  window.location.href=x.invoiceUrl;
 }).catch(function(err){
  alert(err&&err.message?err.message:"Unable to create checkout.");
  if(btn){btn.disabled=false;btn.textContent=oldText||"Checkout"}
 });
}

function sync(r,s,p){
 var f=form(r); if(!f||!p||!p.active)return;
 var v=id((p.product&&p.product.shopifyVariantGid)||r.getAttribute("data-base-variant-gid"));
 if(v){var ii=f.querySelector('input[name="id"],select[name="id"]'); if(ii){ii.value=v;ii.dispatchEvent(new Event("change",{bubbles:true}))}else hid(f,"id").value=v}
 var qi=f.querySelector('input[name="quantity"]'); if(qi){qi.value=String(s.quantity);qi.dispatchEvent(new Event("change",{bubbles:true}))}else hid(f,"quantity").value=String(s.quantity);
 hid(f,"properties[Material]").value=s.material;
 hid(f,"properties[Finish]").value=s.finish;
 hid(f,"properties[Bag Color]").value=s.bagColor;
 hid(f,"properties[_GSO Sides]").value=(p.product&&p.product.defaultSides)||"Double Sided";
 hid(f,"properties[_GSO ERP Product ID]").value=(p.product&&p.product.id)||"";
 hid(f,"properties[_GSO ERP Product Type]").value="4x5 Stock Bag";
 hid(f,"properties[_GSO Price Each]").value=m(p.pricing&&p.pricing.priceEach);
 hid(f,"properties[_GSO Matched Tier]").value=(p.pricing&&p.pricing.matchedRange)||"";
 hid(f,"properties[_gso_configurator]").value="true";
}

function styles(){ensureCartStyles()}

function init(r){
 styles();
 ensureCart();

 if(!r||r.dataset.gsoReady==="true")return;
 r.dataset.gsoReady="true";

 var min=Math.max(parseInt(r.dataset.minimumQuantity||"64",10)||64,1);
 var st={material:"",finish:"",bagColor:"",quantity:min};
 var last=null, first=true;

 var els={
  load:q(r,".gso-configurator__loading"),
  app:q(r,".gso-configurator__app"),
  err:q(r,".gso-configurator__error"),
  mat:q(r,'[data-gso-field="material"]'),
  fin:q(r,'[data-gso-field="finish"]'),
  col:q(r,'[data-gso-field="bagColor"]'),
  qty:q(r,'[data-gso-field="quantity"]')
 };

 if(!els.mat||!els.fin||!els.col||!els.qty)return;

 els.qty.min=String(min);
 els.qty.value=String(min);

 function set(k,v){var x=q(r,'[data-gso-result="'+k+'"]'); if(x)x.textContent=v}
 function show(k,on){var x=q(r,'[data-gso-result="'+k+'"]'); if(x)x.hidden=!on}
 function fail(t){
  if(els.load)els.load.hidden=true;
  if(els.app)els.app.hidden=true;
  if(els.err){els.err.hidden=false;els.err.textContent=t||"Unable to load configurator."}
 }

 function url(){
  var p=new URLSearchParams(), proxy=r.dataset.configuratorProxy||"/apps/wholesale-lite/configurator";
  [["shop",r.dataset.shop],["handle",r.dataset.productHandle],["productGid",r.dataset.productGid],["material",st.material],["finish",st.finish],["bagColor",st.bagColor]].forEach(function(a){if(c(a[1]))p.set(a[0],c(a[1]))});
  p.set("quantity",String(st.quantity||min));
  return proxy+"?"+p.toString();
 }

 function breaks(rows){
  var box=q(r,'[data-gso-result="priceBreaksBox"]'), body=q(r,'[data-gso-result="priceBreaks"]'), on=r.dataset.showPriceBreaks!=="false";
  if(!box||!body)return;
  box.hidden=!(on&&rows&&rows.length);
  body.innerHTML=(rows||[]).map(function(x){return'<div><span>'+e(x.range)+'</span><strong>'+m(x.priceEach)+' each</strong></div>'}).join("");
 }

 function labelButton(){
  var f=form(r);
  if(!f)return;
  var btn=f.querySelector('button[type="submit"],button[name="add"],input[type="submit"]');
  if(btn){
   if(btn.tagName==="INPUT")btn.value="Add to Cart";
   else btn.textContent="Add to Cart";
   btn.setAttribute("aria-label","Add to Cart");
  }
 }

 function currentItem(){
  var prod=(last&&last.product)||{};
  var pr=(last&&last.pricing)||{};
  var img="";
  var imageEl=document.querySelector('.product__media img, .product-media-container img, product-info img, img[src*="cdn.shopify"]');
  if(imageEl)img=imageEl.currentSrc||imageEl.src||"";

  return {
   shop:r.dataset.shop||"",
   checkoutProxy:r.dataset.checkoutProxy||"/apps/wholesale-lite/configurator-checkout",
   handle:r.dataset.productHandle||prod.handle||"",
   productGid:r.dataset.productGid||"",
   title:prod.title||document.querySelector("h1")?.textContent||"Configured Stock Bag",
   sku:prod.sku||"",
   image:img,
   material:st.material,
   finish:st.finish,
   bagColor:st.bagColor,
   sides:prod.defaultSides||"Double Sided",
   quantity:Number(st.quantity||min),
   priceEach:Number(pr.priceEach||0),
   orderTotal:Number(pr.orderTotal||((Number(st.quantity||min))*Number(pr.priceEach||0))),
   matchedRange:pr.matchedRange||"",
   email:r.dataset.customerEmail||""
  };
 }

 function render(p){
  last=p;
  if(!p||!p.ok||!p.active){fail((p&&p.message)||"This product is not connected to the GSO configurator yet.");return}

  var o=p.options||{}, sel=p.selected||{}, pr=p.pricing||{}, prod=p.product||{};
  st.material=sel.material||st.material||(o.materials||[])[0]||"";
  st.finish=sel.finish||st.finish||(o.finishes||[])[0]||"";
  st.bagColor=sel.bagColor||st.bagColor||(o.bagColors||[])[0]||"";
  st.quantity=Math.max(parseInt(sel.quantity||els.qty.value||min,10)||min,Number(prod.minQuantity||min));

  els.mat.innerHTML=opts(o.materials,st.material);
  els.fin.innerHTML=opts(o.finishes,st.finish);
  els.col.innerHTML=opts(o.bagColors,st.bagColor);
  els.qty.value=String(st.quantity);
  els.qty.min=String(prod.minQuantity||min);

  show("priceEachBox",r.dataset.showPriceEach!=="false");
  show("orderTotalBox",r.dataset.showOrderTotal==="true");
  show("matchedTierBox",r.dataset.showMatchedTier==="true");
  show("internalBox",r.dataset.showProfitData==="true");

  set("priceEach",m(pr.priceEach));
  set("orderTotal",m(pr.orderTotal));
  set("matchedTier",pr.matchedRange||"No match");
  set("costEach",m(pr.costEach));
  set("margin",Number(pr.margin||0).toFixed(1)+"%");

  var n=q(r,'[data-gso-result="notice"]');
  if(n)n.textContent="Sides are set to "+(prod.defaultSides||"Double Sided")+". Minimum order is "+(prod.minQuantity||min)+" units.";

  breaks(pr.priceBreaks||[]);

  if(els.load)els.load.hidden=true;
  if(els.err)els.err.hidden=true;
  if(els.app)els.app.hidden=false;

  sync(r,st,p);
  labelButton();

  if(first){
   first=false;
   r.dispatchEvent(new CustomEvent("gso:configurator:ready",{bubbles:true,detail:p}));
  }
 }

 function go(){
  if(els.load&&first)els.load.hidden=false;
  fetch(url(),{credentials:"same-origin"}).then(function(x){return x.json()}).then(render).catch(function(){fail("Unable to load GSO configurator pricing.")});
 }

 function upd(){
  st.material=els.mat.value||st.material;
  st.finish=els.fin.value||st.finish;
  st.bagColor=els.col.value||st.bagColor;
  st.quantity=Math.max(parseInt(els.qty.value||min,10)||min,min);
  go();
 }

 ["change","input"].forEach(function(ev){els.qty.addEventListener(ev,upd)});
 els.mat.addEventListener("change",upd);
 els.fin.addEventListener("change",upd);
 els.col.addEventListener("change",upd);

 var f=form(r);
 if(f){
  f.addEventListener("submit",function(ev){
   ev.preventDefault();
   ev.stopPropagation();
   if(ev.stopImmediatePropagation)ev.stopImmediatePropagation();
   if(!last||!last.ok||!last.active){alert("GSO configurator is not ready yet.");return false}
   sync(r,st,last);
   addCartItem(currentItem());
   return false;
  },true);
 }

 go();
}

function all(){
 document.querySelectorAll(".gso-configurator").forEach(init);
 ensureCart();
}
document.addEventListener("DOMContentLoaded",all);
document.addEventListener("shopify:section:load",all);
document.addEventListener("shopify:block:select",all);
window.GSOProductConfiguratorInit=all;
})();

