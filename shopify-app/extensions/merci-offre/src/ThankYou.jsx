import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

const API_URL = 'https://aosom-sync.vercel.app/api/merci/offer';
const MAX_TRIES = 6;
const RETRY_MS = 3000;

export default async () => {
  render(<Extension />, document.body);
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function money(n) {
  return new Intl.NumberFormat('fr-CA', {style: 'currency', currency: 'CAD'}).format(n);
}

function remaining(expiresAt, now) {
  const left = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  const m = String(Math.floor(left / 60)).padStart(2, '0');
  const s = String(left % 60).padStart(2, '0');
  return {left, label: `${m}:${s}`};
}

function Extension() {
  const [data, setData] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const orderId = shopify.orderConfirmation.value?.order?.id;
      if (!orderId) return;
      for (let i = 0; i < MAX_TRIES && !cancelled; i++) {
        try {
          const token = await shopify.sessionToken.get();
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({orderId}),
          });
          if (res.status === 202) {
            await sleep(RETRY_MS);
            continue;
          }
          if (!res.ok) return;
          const json = await res.json();
          if (!cancelled && json && Array.isArray(json.offers) && json.offers.length && json.expiresAt) setData(json);
          return;
        } catch {
          return;
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!data) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [data]);

  if (!data) return null;
  const {left, label} = remaining(data.expiresAt, now);
  if (left <= 0) return null;

  const [main, alt] = data.offers;
  const pcts = [...new Set(data.offers.map((o) => o.pct))].join(' % ou ');

  return (
    <s-section heading="Offre de remerciement">
      <s-stack gap="base">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text color="subdued">Valide encore</s-text>
          <s-badge tone="neutral">{label}</s-badge>
        </s-stack>

        <s-grid gridTemplateColumns="96px 1fr" gap="base" alignItems="center">
          <s-image src={main.imageUrl} alt={main.title} aspectRatio="1/1" objectFit="cover" borderRadius="base" inlineSize="fill" />
          <s-stack gap="small-200">
            <s-text type="strong">{main.title}</s-text>
            <s-text color="subdued">{main.why}</s-text>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-text type="redundant" color="subdued">{money(main.price)}</s-text>
              <s-text type="strong">{money(main.discountedPrice)}</s-text>
              <s-badge tone="neutral">−{main.pct} %</s-badge>
            </s-stack>
          </s-stack>
        </s-grid>

        <s-button variant="primary" inlineSize="fill" href={main.checkoutUrlShopPay} target="_blank">
          Ajouter avec Shop Pay
        </s-button>
        <s-link href={main.checkoutUrl} target="_blank">
          Payer autrement
        </s-link>

        {alt ? (
          <s-stack gap="base">
            <s-divider />
            <s-grid gridTemplateColumns="56px 1fr auto" gap="base" alignItems="center">
              <s-image src={alt.imageUrl} alt={alt.title} aspectRatio="1/1" objectFit="cover" borderRadius="base" inlineSize="fill" />
              <s-stack gap="none">
                <s-text>{alt.title}</s-text>
                <s-stack direction="inline" gap="small-200">
                  <s-text type="redundant" color="subdued">{money(alt.price)}</s-text>
                  <s-text type="strong">{money(alt.discountedPrice)}</s-text>
                </s-stack>
              </s-stack>
              <s-link href={alt.checkoutUrl} target="_blank">
                Choisir
              </s-link>
            </s-grid>
          </s-stack>
        ) : null}

        <s-text type="small" color="subdued">
          Nouvelle commande séparée, livrée séparément. Rabais de {pcts} % valide 30 minutes, sur ces articles
          seulement. 1 utilisation, non cumulable avec d'autres offres.
        </s-text>
      </s-stack>
    </s-section>
  );
}
