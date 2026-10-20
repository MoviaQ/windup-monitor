import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("pokazuje generyczny błąd przy 401 i nie wycieka szczegółów serwera", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "sekretny powod bledu bcrypt" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const onDone = vi.fn();
    render(<LoginPage onDone={onDone} />);

    await user.type(screen.getByLabelText("E-mail"), "admin@example.com");
    await user.type(screen.getByLabelText("Hasło"), "zle-haslo-1234");
    await user.click(screen.getByRole("button", { name: "Zaloguj" }));

    expect(await screen.findByText("Nieprawidłowy e-mail lub hasło.")).toBeInTheDocument();
    expect(screen.queryByText(/sekretny powod/)).not.toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("wymaga e-maila i hasła przed wysłaniem", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage onDone={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Zaloguj" }));
    expect(await screen.findByText("Podaj e-mail i hasło.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
