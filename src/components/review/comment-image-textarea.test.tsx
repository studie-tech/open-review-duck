// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentImageTextarea } from "./comment-image-textarea";

afterEach(cleanup);

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

/** Exercises the controlled draft and submission gate together. */
function Composer({ upload }: { upload: (file: File) => Promise<string> }) {
  const [value, setValue] = useState("before selected after");
  const [uploading, setUploading] = useState(false);
  return (
    <>
      <CommentImageTextarea
        aria-label="Comment"
        value={value}
        onValueChange={setValue}
        onUploadingChange={setUploading}
        onUploadImage={upload}
      />
      <button type="button" disabled={uploading}>
        Post
      </button>
    </>
  );
}

/** Delivers the same image item shape as a native clipboard paste. */
function paste(file: File) {
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
    },
  });
}

describe("comment image paste", () => {
  it("replaces the selection with the provider link and blocks submission while uploading", async () => {
    let resolve!: (value: string) => void;
    const upload = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    render(<Composer upload={upload} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    textarea.setSelectionRange(7, 15);
    paste(new File(["image"], "image.png", { type: "image/png" }));
    expect(screen.getByRole("button")).toBeDisabled();
    expect(textarea).toHaveAttribute("readonly");
    expect(screen.getByRole("status")).toHaveTextContent("Uploading image");
    await act(async () =>
      resolve("![Image](https://provider.example/image.png)"),
    );
    expect(textarea.value).toBe(
      "before ![Image](https://provider.example/image.png) after",
    );
    expect(screen.getByRole("button")).toBeEnabled();
  });
  it("keeps the draft and allows retry after upload failure", async () => {
    render(
      <Composer
        upload={vi.fn().mockRejectedValue(new Error("Upload refused"))}
      />,
    );
    await act(async () =>
      paste(new File(["image"], "image.png", { type: "image/png" })),
    );
    expect(screen.getByRole("textbox")).toHaveValue("before selected after");
    expect(screen.getByRole("button")).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith("Upload refused");
  });
  it("rejects oversized and unsupported image files before calling the provider", () => {
    const upload = vi.fn();
    render(<Composer upload={upload} />);
    paste(
      new File([new Uint8Array(2 * 1024 * 1024 + 1)], "image.png", {
        type: "image/png",
      }),
    );
    paste(new File(["<svg/>"], "image.svg", { type: "image/svg+xml" }));
    expect(upload).not.toHaveBeenCalled();
  });
  it("leaves ordinary text paste to the browser", () => {
    render(<Composer upload={vi.fn()} />);
    expect(
      fireEvent.paste(screen.getByRole("textbox"), {
        clipboardData: { items: [{ kind: "string", type: "text/plain" }] },
      }),
    ).toBe(true);
  });
});
