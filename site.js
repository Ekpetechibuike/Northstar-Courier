// ====== EDIT YOUR BUSINESS DETAILS HERE ======
// Leave a value empty ("") to hide it. The WhatsApp and Call buttons only appear once these are filled in.
const NORTHSTAR_SITE = {
  phone: "",          // e.g. "+234 801 234 5678"
  whatsapp: "",       // digits only, with country code, e.g. "2348012345678"
  email: "",          // e.g. "hello@yourdomain.com"
  address: "",        // e.g. "12 Allen Avenue, Ikeja, Lagos"
  hours: "",          // e.g. "Mon to Sat, 8am to 6pm"
  whatsappMessage: "Hello Northstar, I need help with a delivery."
};
// ===============================================

(function () {
  const site = NORTHSTAR_SITE;
  const digits = (value) => String(value || "").replace(/[^\d+]/g, "");

  function fill(name, text, href) {
    document.querySelectorAll(`[data-site="${name}"]`).forEach((element) => {
      if (!text) return;
      if (name !== "whatsapp") element.textContent = text;
      if (href && element.tagName === "A") element.setAttribute("href", href);
      element.hidden = false;
    });
  }
  const whatsappUrl = site.whatsapp ? `https://wa.me/${digits(site.whatsapp).replace("+", "")}?text=${encodeURIComponent(site.whatsappMessage)}` : "";
  fill("phone", site.phone, site.phone ? `tel:${digits(site.phone)}` : "");
  fill("whatsapp", site.whatsapp ? "Chat on WhatsApp" : "", whatsappUrl);
  fill("email", site.email, site.email ? `mailto:${site.email}` : "");
  fill("address", site.address);
  fill("hours", site.hours);

  // Floating contact buttons (only when a number is set)
  if (whatsappUrl || site.phone) {
    const wrap = document.createElement("div");
    wrap.className = "contact-fab";
    if (site.phone) {
      const call = document.createElement("a");
      call.href = `tel:${digits(site.phone)}`;
      call.className = "contact-fab-call";
      call.setAttribute("aria-label", "Call Northstar");
      call.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5h2.8l1.4 4-1.9 1.5a11 11 0 0 0 5.1 5.1l1.5-1.9 4 1.4v2.8a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" fill="currentColor"/></svg>';
      wrap.appendChild(call);
    }
    if (whatsappUrl) {
      const chat = document.createElement("a");
      chat.href = whatsappUrl;
      chat.target = "_blank";
      chat.rel = "noopener noreferrer";
      chat.className = "contact-fab-chat";
      chat.setAttribute("aria-label", "Chat with Northstar on WhatsApp");
      chat.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h14a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V5.500a2 2 0 0 1 2-2Z" fill="currentColor"/></svg><span>WhatsApp</span>';
      wrap.appendChild(chat);
    }
    document.body.appendChild(wrap);
  }

  // Live price estimate on the booking form
  const size = document.getElementById("booking-size");
  const weight = document.getElementById("booking-weight");
  const service = document.getElementById("booking-service");
  const estimate = document.getElementById("booking-estimate");
  const date = document.getElementById("booking-date");
  if (date) {
    const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    date.min = today;
    date.value = today;
  }
  if (size && weight && service && estimate) {
    let timer;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const params = new URLSearchParams({ size: size.value, weight: weight.value, service: service.value });
        try {
          const response = await fetch(`/api/quote?${params}`);
          const quote = await response.json();
          if (!response.ok) throw new Error();
          const money = new Intl.NumberFormat("en-NG", { style: "currency", currency: quote.currency, maximumFractionDigits: 0 }).format(quote.amount);
          estimate.textContent = `Estimated price: ${money}. Our team confirms the final price before pickup.`;
        } catch {
          estimate.textContent = "";
        }
      }, 250);
    };
    [size, weight, service].forEach((control) => control.addEventListener("input", update));
    update();
  }
})();
