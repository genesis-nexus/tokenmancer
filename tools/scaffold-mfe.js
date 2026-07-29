#!/usr/bin/env node
/*
 * scaffold_mfe_demo.js — generate a deterministic Module-Federation microfrontend
 * repo for the Copilot token demo. Same files, same bytes, every run — so token
 * counts are reproducible.
 *
 *   node scaffold_mfe_demo.js            # creates ./mfe-demo
 *   node scaffold_mfe_demo.js ../mfe     # custom target dir
 *
 * Structure: a host shell + three remotes (product, cart, checkout) + a shared
 * package (design system, utils, store, hooks, types). The shared util
 * `formatPrice` is imported by all three remotes — that cross-file fan-out is the
 * target for the "explore vs targeted retrieval" experiment. `validateEmail` is
 * the small, self-contained edit target for the output-discipline / multi-turn
 * experiments. Files are realistic TS/React but the repo is a token fixture; it
 * is not wired to build.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || 'mfe-demo');

// --- helpers that emit small, realistic, deterministic files ----------------
const featureCard = (name) => `import React from 'react';
import { Card } from '@shared/design-system/Card';
import { Button } from '@shared/design-system/Button';
import { formatPrice } from '@shared/utils/formatPrice';
import type { ${name} } from './${name.toLowerCase()}.types';

interface Props { item: ${name}; onSelect: (id: string) => void; }

export const ${name}Card: React.FC<Props> = ({ item, onSelect }) => {
  return (
    <Card data-testid={\`${name.toLowerCase()}-\${item.id}\`}>
      <h3>{item.title}</h3>
      <p className="muted">{item.summary}</p>
      <span className="price">{formatPrice(item.priceCents, item.currency)}</span>
      <Button variant="primary" onClick={() => onSelect(item.id)}>View</Button>
    </Card>
  );
};
`;

const featureHook = (name) => `import { useEffect, useState, useCallback } from 'react';
import { http } from '@shared/utils/http';
import { logger } from '@shared/utils/logger';
import type { ${name} } from './${name.toLowerCase()}.types';

export function use${name}s() {
  const [items, setItems] = useState<${name}[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await http.get<${name}[]>('/api/${name.toLowerCase()}s');
      setItems(data);
    } catch (e) {
      logger.error('failed to load ${name.toLowerCase()}s', e);
      setError('Unable to load ${name.toLowerCase()}s');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { items, loading, error, reload: load };
}
`;

const featureTypes = (name) => `export interface ${name} {
  id: string;
  title: string;
  summary: string;
  priceCents: number;
  currency: 'USD' | 'EUR' | 'LKR';
  tags: string[];
  updatedAt: string;
}
`;

const mfConfig = (name, exposes) => `const { ModuleFederationPlugin } = require('webpack').container;
const deps = require('./package.json').dependencies;

module.exports = {
  output: { publicPath: 'auto' },
  plugins: [
    new ModuleFederationPlugin({
      name: '${name}',
      filename: 'remoteEntry.js',
      exposes: ${JSON.stringify(exposes, null, 6)},
      shared: {
        react: { singleton: true, requiredVersion: deps.react },
        'react-dom': { singleton: true, requiredVersion: deps['react-dom'] },
      },
    }),
  ],
};
`;

// --- the explicit file map --------------------------------------------------
const files = {
  'package.json': JSON.stringify({
    name: 'mfe-demo', private: true, version: '1.0.0',
    workspaces: ['host', 'remotes/*', 'shared'],
    scripts: { dev: 'echo "token fixture — not wired to build"' },
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
    devDependencies: { typescript: '^5.5.0', webpack: '^5.93.0' },
  }, null, 2) + '\n',
  '.gitignore': 'node_modules\ndist\n.copilot-meter\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2021', module: 'ESNext', jsx: 'react-jsx', strict: true,
      moduleResolution: 'bundler', baseUrl: '.',
      paths: { '@shared/*': ['shared/src/*'] },
    },
  }, null, 2) + '\n',
  'README.md': `# mfe-demo\n\nA Module-Federation microfrontend fixture for the GitHub Copilot token demo.\n\n- \`host/\` — application shell, routing, layout\n- \`remotes/product\`, \`remotes/cart\`, \`remotes/checkout\` — independently deployable remotes\n- \`shared/\` — design system, utils, store, hooks, types\n\n\`shared/src/utils/formatPrice.ts\` is imported by every remote (the cross-file target).\n\`shared/src/utils/validateEmail.ts\` is the small edit target.\n`,

  // ---- host shell ----
  'host/package.json': JSON.stringify({ name: 'host', version: '1.0.0',
    dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }, null, 2) + '\n',
  'host/webpack.config.js': `const { ModuleFederationPlugin } = require('webpack').container;
module.exports = {
  output: { publicPath: 'auto' },
  plugins: [ new ModuleFederationPlugin({
    name: 'host',
    remotes: {
      product:  'product@http://localhost:3001/remoteEntry.js',
      cart:     'cart@http://localhost:3002/remoteEntry.js',
      checkout: 'checkout@http://localhost:3003/remoteEntry.js',
    },
  }) ],
};
`,
  'host/src/bootstrap.tsx': `import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
  'host/src/App.tsx': `import React, { Suspense, lazy } from 'react';
import { Header } from './shell/Header';
import { Footer } from './shell/Footer';
import { routes } from './routes';

const screens = routes.map(r => ({ ...r, C: lazy(r.load) }));

export const App: React.FC = () => {
  const [path, setPath] = React.useState(window.location.pathname);
  const match = screens.find(s => s.path === path) ?? screens[0];
  return (
    <div className="app-shell">
      <Header onNavigate={setPath} />
      <main>
        <Suspense fallback={<div>Loading microfrontend…</div>}>
          <match.C />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
};
`,
  'host/src/routes.tsx': `export const routes = [
  { path: '/',         label: 'Home',     load: () => import('product/ProductList') },
  { path: '/cart',     label: 'Cart',     load: () => import('cart/CartView') },
  { path: '/checkout', label: 'Checkout', load: () => import('checkout/Checkout') },
];
`,
  'host/src/shell/Header.tsx': `import React from 'react';
import { Nav } from './Nav';
export const Header: React.FC<{ onNavigate: (p: string) => void }> = ({ onNavigate }) => (
  <header className="app-header">
    <span className="logo">Acme Store</span>
    <Nav onNavigate={onNavigate} />
  </header>
);
`,
  'host/src/shell/Nav.tsx': `import React from 'react';
import { routes } from '../routes';
export const Nav: React.FC<{ onNavigate: (p: string) => void }> = ({ onNavigate }) => (
  <nav>{routes.map(r => (
    <a key={r.path} href={r.path} onClick={e => { e.preventDefault(); onNavigate(r.path); }}>{r.label}</a>
  ))}</nav>
);
`,
  'host/src/shell/Footer.tsx': `import React from 'react';
export const Footer: React.FC = () => (
  <footer className="app-footer"><small>© Acme — microfrontend demo</small></footer>
);
`,

  // ---- shared: design system ----
  'shared/package.json': JSON.stringify({ name: '@shared/ui', version: '1.0.0' }, null, 2) + '\n',
  'shared/src/design-system/Button.tsx': `import React from 'react';
type Variant = 'primary' | 'secondary' | 'ghost';
export const Button: React.FC<React.PropsWithChildren<{ variant?: Variant; onClick?: () => void }>> =
  ({ variant = 'secondary', onClick, children }) => (
    <button className={\`btn btn--\${variant}\`} onClick={onClick}>{children}</button>
  );
`,
  'shared/src/design-system/Input.tsx': `import React from 'react';
export const Input: React.FC<{ value: string; onChange: (v: string) => void; label: string; type?: string }> =
  ({ value, onChange, label, type = 'text' }) => (
    <label className="field"><span>{label}</span>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} />
    </label>
  );
`,
  'shared/src/design-system/Card.tsx': `import React from 'react';
export const Card: React.FC<React.PropsWithChildren<Record<string, unknown>>> = ({ children, ...rest }) => (
  <div className="card" {...rest}>{children}</div>
);
`,
  'shared/src/design-system/Spinner.tsx': `import React from 'react';
export const Spinner: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <span className="spinner" style={{ width: size, height: size }} aria-label="loading" />
);
`,

  // ---- shared: utils (the cross-file + edit targets) ----
  'shared/src/utils/formatPrice.ts': `// Imported by product, cart and checkout — the cross-file fan-out target.
const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', LKR: 'Rs ' };

export function formatPrice(cents: number, currency: 'USD' | 'EUR' | 'LKR' = 'USD'): string {
  const major = (cents / 100).toFixed(2);
  const symbol = SYMBOLS[currency] ?? '';
  const grouped = major.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  return \`\${symbol}\${grouped}\`;
}

export function sumCents(values: number[]): number {
  return values.reduce((a, v) => a + v, 0);
}
`,
  'shared/src/utils/validateEmail.ts': `// Small, self-contained edit target for the output-discipline / multi-turn experiments.
export function validateEmail(email: string): boolean {
  if (!email) return false;
  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email);
}
`,
  'shared/src/utils/http.ts': `export const http = {
  async get<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(\`GET \${url} -> \${res.status}\`);
    return res.json() as Promise<T>;
  },
  async post<T>(url: string, body: unknown): Promise<T> {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(\`POST \${url} -> \${res.status}\`);
    return res.json() as Promise<T>;
  },
};
`,
  'shared/src/utils/logger.ts': `type Level = 'debug' | 'info' | 'warn' | 'error';
function emit(level: Level, msg: string, meta?: unknown) {
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](\`[\${level}] \${msg}\`, meta ?? '');
}
export const logger = {
  debug: (m: string, x?: unknown) => emit('debug', m, x),
  info:  (m: string, x?: unknown) => emit('info', m, x),
  warn:  (m: string, x?: unknown) => emit('warn', m, x),
  error: (m: string, x?: unknown) => emit('error', m, x),
};
`,

  // ---- shared: store, hooks, types ----
  'shared/src/store/store.ts': `import { cartReducer, type CartState } from './cartSlice';
export interface RootState { cart: CartState; }
type Action = { type: string; payload?: unknown };
const listeners = new Set<() => void>();
let state: RootState = { cart: cartReducer(undefined, { type: '@@init' }) };
export const store = {
  getState: () => state,
  dispatch(action: Action) { state = { cart: cartReducer(state.cart, action) }; listeners.forEach(l => l()); },
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
};
`,
  'shared/src/store/cartSlice.ts': `export interface CartLine { id: string; qty: number; priceCents: number; }
export interface CartState { lines: CartLine[]; }
const initial: CartState = { lines: [] };
export function cartReducer(state: CartState = initial, action: { type: string; payload?: any }): CartState {
  switch (action.type) {
    case 'cart/add': return { lines: [...state.lines, action.payload] };
    case 'cart/clear': return { lines: [] };
    default: return state;
  }
}
`,
  'shared/src/hooks/useDebounce.ts': `import { useEffect, useState } from 'react';
export function useDebounce<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
`,
  'shared/src/types/index.ts': `export type Currency = 'USD' | 'EUR' | 'LKR';
export type Id = string;
export interface Money { cents: number; currency: Currency; }
`,
};

// ---- remotes: product / cart / checkout (templated + explicit) ----
const remotes = {
  product: { exposes: { './ProductList': './src/ProductList', './ProductCard': './src/ProductCard' }, port: 3001 },
  cart:     { exposes: { './CartView': './src/CartView' }, port: 3002 },
  checkout: { exposes: { './Checkout': './src/Checkout' }, port: 3003 },
};
for (const [name, cfg] of Object.entries(remotes)) {
  files[`remotes/${name}/package.json`] = JSON.stringify({ name, version: '1.0.0' }, null, 2) + '\n';
  files[`remotes/${name}/webpack.config.js`] = mfConfig(name, cfg.exposes);
}
// product remote files (feature-rich)
files['remotes/product/src/product.types.ts'] = featureTypes('Product');
files['remotes/product/src/useProducts.ts'] = featureHook('Product');
files['remotes/product/src/ProductCard.tsx'] = featureCard('Product');
files['remotes/product/src/ProductList.tsx'] = `import React from 'react';
import { useProducts } from './useProducts';
import { ProductCard } from './ProductCard';
import { Spinner } from '@shared/design-system/Spinner';
export default function ProductList() {
  const { items, loading, error } = useProducts();
  if (loading) return <Spinner />;
  if (error) return <p role="alert">{error}</p>;
  return <div className="grid">{items.map(p => <ProductCard key={p.id} item={p} onSelect={() => {}} />)}</div>;
}
`;
files['remotes/product/src/ProductDetail.tsx'] = `import React from 'react';
import { formatPrice } from '@shared/utils/formatPrice';
import type { Product } from './product.types';
export const ProductDetail: React.FC<{ product: Product }> = ({ product }) => (
  <article><h1>{product.title}</h1><p>{product.summary}</p>
    <strong>{formatPrice(product.priceCents, product.currency)}</strong></article>
);
`;
// cart remote
files['remotes/cart/src/cart.types.ts'] = `export interface CartItem { id: string; title: string; qty: number; priceCents: number; currency: 'USD'|'EUR'|'LKR'; }`;
files['remotes/cart/src/useCart.ts'] = `import { useSyncExternalStore } from 'react';
import { store } from '@shared/store/store';
export const useCart = () => useSyncExternalStore(store.subscribe, () => store.getState().cart);
`;
files['remotes/cart/src/CartItem.tsx'] = `import React from 'react';
import { formatPrice } from '@shared/utils/formatPrice';
import type { CartItem as Item } from './cart.types';
export const CartItem: React.FC<{ item: Item }> = ({ item }) => (
  <li className="cart-row"><span>{item.title} × {item.qty}</span>
    <span>{formatPrice(item.priceCents * item.qty, item.currency)}</span></li>
);
`;
files['remotes/cart/src/CartView.tsx'] = `import React from 'react';
import { useCart } from './useCart';
import { CartItem } from './CartItem';
import { formatPrice, sumCents } from '@shared/utils/formatPrice';
export default function CartView() {
  const cart = useCart();
  const total = sumCents(cart.lines.map(l => l.priceCents * l.qty));
  return (<section><h2>Your cart</h2>
    <ul>{cart.lines.map(l => <CartItem key={l.id} item={{ id: l.id, title: l.id, qty: l.qty, priceCents: l.priceCents, currency: 'USD' }} />)}</ul>
    <p className="total">Total: {formatPrice(total, 'USD')}</p></section>);
}
`;
// checkout remote
files['remotes/checkout/src/useCheckout.ts'] = `import { useState } from 'react';
import { validateEmail } from '@shared/utils/validateEmail';
import { http } from '@shared/utils/http';
export function useCheckout() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = validateEmail(email);
  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try { await http.post('/api/checkout', { email }); } finally { setSubmitting(false); }
  }
  return { email, setEmail, canSubmit, submitting, submit };
}
`;
files['remotes/checkout/src/PaymentForm.tsx'] = `import React from 'react';
import { Input } from '@shared/design-system/Input';
import { Button } from '@shared/design-system/Button';
export const PaymentForm: React.FC<{ email: string; onEmail: (v: string) => void; onPay: () => void; disabled: boolean }> =
  ({ email, onEmail, onPay, disabled }) => (
    <form onSubmit={e => { e.preventDefault(); onPay(); }}>
      <Input label="Email" type="email" value={email} onChange={onEmail} />
      <Button variant="primary" onClick={onPay}>{disabled ? 'Enter a valid email' : 'Pay now'}</Button>
    </form>
  );
`;
files['remotes/checkout/src/Checkout.tsx'] = `import React from 'react';
import { useCheckout } from './useCheckout';
import { PaymentForm } from './PaymentForm';
export default function Checkout() {
  const { email, setEmail, canSubmit, submit } = useCheckout();
  return (<section><h2>Checkout</h2>
    <PaymentForm email={email} onEmail={setEmail} onPay={submit} disabled={!canSubmit} /></section>);
}
`;
// mocks
files['mocks/products.json'] = JSON.stringify(
  Array.from({ length: 8 }, (_, i) => ({
    id: `p${i + 1}`, title: `Product ${i + 1}`, summary: 'A finely crafted demo product.',
    priceCents: 1999 + i * 500, currency: 'USD', tags: ['demo', i % 2 ? 'sale' : 'new'],
    updatedAt: '2026-01-01T00:00:00Z',
  })), null, 2) + '\n';

// --- write everything -------------------------------------------------------
let count = 0;
for (const [rel, content] of Object.entries(files)) {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  count++;
}
console.log(`✓ wrote ${count} files to ${ROOT}`);
console.log(`  cross-file target : shared/src/utils/formatPrice.ts (used by 3 remotes)`);
console.log(`  edit target       : shared/src/utils/validateEmail.ts`);
console.log(`\nNext:\n  cd ${path.relative(process.cwd(), ROOT) || '.'} && git init -q && git add -A && git commit -qm "demo baseline"`);
