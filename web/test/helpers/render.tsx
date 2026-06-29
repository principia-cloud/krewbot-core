import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

interface Options extends Omit<RenderOptions, 'wrapper'> {
  /** Initial route path. Defaults to '/'. */
  route?: string;
  /** Route pattern that the rendered element should match. Defaults to '*'. */
  path?: string;
  /** Extra wrapper applied inside the router. */
  wrap?: (children: ReactNode) => ReactNode;
}

/**
 * Render a component inside a MemoryRouter. By default, the element is
 * mounted at '*' so it sees the initial path verbatim. Pass `path` and
 * `route` to exercise route-param-aware components (e.g. WorkspaceLayout
 * needs `:id`).
 */
export function renderWithRouter(ui: ReactElement, opts: Options = {}) {
  const { route = '/', path = '*', wrap, ...rest } = opts;
  const inner = wrap ? wrap(ui) : ui;
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path={path} element={inner} />
      </Routes>
    </MemoryRouter>,
    rest,
  );
}
