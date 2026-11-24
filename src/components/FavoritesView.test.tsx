import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Provider } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFavoriteTracks } from "../api/tidal";
import { favoriteTrackIdsAtom } from "../atoms/favorites";
import { PageScrollProvider } from "../contexts/PageScrollContext";
import { ToastProvider } from "../contexts/ToastContext";
import { FAVORITE_TRACKS_PAGE_SIZE } from "../lib/trackSources";
import FavoritesView from "./FavoritesView";
import { signedIn } from "./tv/tvTestUtils";

vi.mock(import("../api/tidal"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFavoriteTracks: vi.fn(),
  getFavoriteVideos: vi.fn().mockResolvedValue([]),
}));

const observed = new Map<Element, () => void>();
const getTracks = vi.mocked(getFavoriteTracks);
const page = { limit: FAVORITE_TRACKS_PAGE_SIZE, totalNumberOfItems: 250 };
const requestedOffsets = () => getTracks.mock.calls.map(([, offset]) => offset);

class StubIntersectionObserver {
  private target?: Element;

  constructor(
    private callback: (entries: { isIntersecting: boolean }[]) => void,
  ) {}

  observe(target: Element) {
    this.target = target;
    observed.set(target, () => this.callback([{ isIntersecting: true }]));
  }

  disconnect() {
    if (this.target) observed.delete(this.target);
  }
}

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  // Reject unexpected requests so a non-advancing loop cannot hang the test.
  getTracks
    .mockReset()
    .mockRejectedValue(new Error("Unexpected favorite tracks request"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  observed.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderFavorites(favoriteIds: number[] = []) {
  const store = signedIn(42);
  store.set(favoriteTrackIdsAtom, new Set(favoriteIds));
  const scroller = document.createElement("div");
  // Give the real virtualized TrackList a nonzero viewport in jsdom.
  Object.defineProperties(scroller, {
    offsetHeight: { value: 480 },
    offsetWidth: { value: 800 },
  });
  await act(async () => {
    render(
      <Provider store={store}>
        <ToastProvider>
          <PageScrollProvider element={scroller}>
            <FavoritesView onBack={vi.fn()} />
          </PageScrollProvider>
        </ToastProvider>
      </Provider>,
    );
  });
}

async function focusSearch() {
  await act(async () => {
    fireEvent.focus(
      screen.getByPlaceholderText("Filter on title, artist or album"),
    );
    await vi.advanceTimersByTimeAsync(0);
  });
}

it.each(["search focus", "infinite scroll"])(
  "stops paging after an empty favorite tracks page via %s",
  async (trigger) => {
    const track = { id: 10, title: "Still loved", duration: 180 };
    getTracks
      .mockResolvedValueOnce({ ...page, offset: 0, items: [track] })
      .mockResolvedValueOnce({ ...page, offset: 1, items: [] });
    await renderFavorites([track.id]);

    expect(screen.getByText(track.title)).toBeTruthy();
    expect(screen.getAllByText("250 TRACKS")).toHaveLength(2);
    expect(requestedOffsets()).toEqual([0]);
    expect(observed.size).toBe(1);
    const [[sentinel, intersect]] = observed;
    if (trigger === "search focus") {
      await focusSearch();
    } else {
      await act(async () => intersect());
    }

    expect(requestedOffsets()).toEqual([0, 1]);
    expect(screen.getByText(track.title)).toBeTruthy();
    expect(screen.getAllByText("1 TRACK")).toHaveLength(2);
    expect(observed.size).toBe(0);
    expect(sentinel.isConnected).toBe(false);

    fireEvent.blur(
      screen.getByPlaceholderText("Filter on title, artist or album"),
    );
    await focusSearch();
    expect(requestedOffsets()).toEqual([0, 1]);
  },
);

it("does not retry an empty first page when search receives focus", async () => {
  getTracks.mockResolvedValueOnce({ ...page, offset: 0, items: [] });
  await renderFavorites();
  expect(screen.getByText("0 TRACKS")).toBeTruthy();
  expect(screen.getByText("No loved tracks yet")).toBeTruthy();
  expect(observed.size).toBe(0);

  await focusSearch();
  expect(requestedOffsets()).toEqual([0]);
});
