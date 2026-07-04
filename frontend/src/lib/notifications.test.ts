import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canNotify,
  notificationPermission,
  notifyDeployResult,
  requestPermission,
  sendNotification,
} from "./notifications";

// jsdom does not implement the Notification API, so `"Notification" in
// window` is false unless we stub it in. `vi.stubGlobal` attaches the stub
// to the same global object jsdom exposes as `window`, so canNotify()'s
// `"Notification" in window` check sees it like a real browser would.
class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();

  title: string;
  body?: string;
  tag?: string;
  icon?: string;
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(title: string, options?: { body?: string; tag?: string; icon?: string }) {
    this.title = title;
    this.body = options?.body;
    this.tag = options?.tag;
    this.icon = options?.icon;
  }
}

describe("canNotify / notificationPermission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("canNotify is false when window has no Notification constructor", () => {
    expect(canNotify()).toBe(false);
  });

  it("notificationPermission returns 'unsupported' when Notification is unavailable", () => {
    expect(notificationPermission()).toBe("unsupported");
  });

  it("canNotify is true once Notification is present", () => {
    vi.stubGlobal("Notification", FakeNotification);
    expect(canNotify()).toBe(true);
  });

  it("notificationPermission mirrors Notification.permission when supported", () => {
    FakeNotification.permission = "denied";
    vi.stubGlobal("Notification", FakeNotification);
    expect(notificationPermission()).toBe("denied");
  });
});

describe("requestPermission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when Notification is unsupported, without calling requestPermission", async () => {
    await expect(requestPermission()).resolves.toBe(false);
  });

  it("returns true immediately when permission is already 'granted'", async () => {
    FakeNotification.permission = "granted";
    FakeNotification.requestPermission = vi.fn();
    vi.stubGlobal("Notification", FakeNotification);

    await expect(requestPermission()).resolves.toBe(true);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("returns false immediately when permission is already 'denied'", async () => {
    FakeNotification.permission = "denied";
    FakeNotification.requestPermission = vi.fn();
    vi.stubGlobal("Notification", FakeNotification);

    await expect(requestPermission()).resolves.toBe(false);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("prompts via Notification.requestPermission() when permission is 'default', returns true on grant", async () => {
    FakeNotification.permission = "default";
    FakeNotification.requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", FakeNotification);

    await expect(requestPermission()).resolves.toBe(true);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("returns false when the user dismisses/denies the prompt", async () => {
    FakeNotification.permission = "default";
    FakeNotification.requestPermission = vi.fn().mockResolvedValue("denied");
    vi.stubGlobal("Notification", FakeNotification);

    await expect(requestPermission()).resolves.toBe(false);
  });
});

describe("sendNotification", () => {
  let instances: FakeNotification[];
  let NotificationSpy: typeof FakeNotification;

  beforeEach(() => {
    instances = [];
    // Wrap the class so we can record every instance it constructs, since
    // sendNotification calls `new Notification(...)` internally.
    class RecordingNotification extends FakeNotification {
      constructor(title: string, options?: { body?: string; tag?: string; icon?: string }) {
        super(title, options);
        instances.push(this);
      }
    }
    NotificationSpy = RecordingNotification as unknown as typeof FakeNotification;
    NotificationSpy.permission = "granted";
    vi.stubGlobal("Notification", NotificationSpy);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does nothing when Notification is unsupported", () => {
    vi.unstubAllGlobals();
    expect(() => sendNotification("title")).not.toThrow();
    expect(instances).toHaveLength(0);
  });

  it("does nothing when permission is not 'granted'", () => {
    NotificationSpy.permission = "denied";
    sendNotification("title");
    expect(instances).toHaveLength(0);
  });

  it("constructs a Notification with the given title/body, a default tag, and the app icon", () => {
    sendNotification("Deploy successful", { body: "my-app — success" });

    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      title: "Deploy successful",
      body: "my-app — success",
      tag: "deploy-panel",
      icon: "/favicon.svg",
    });
  });

  it("uses the given tag when provided", () => {
    sendNotification("Deploy successful", { tag: "deploy-my-app" });

    expect(instances[0].tag).toBe("deploy-my-app");
  });

  it("auto-closes the notification after 8 seconds", () => {
    sendNotification("Deploy successful");
    expect(instances[0].close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(8000);

    expect(instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("focuses the window and closes the notification on click", () => {
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => {});
    sendNotification("Deploy successful");

    instances[0].onclick?.();

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing Notification constructor", () => {
    class ThrowingNotification extends FakeNotification {
      constructor() {
        super("");
        throw new Error("Notification constructor blocked");
      }
    }
    vi.stubGlobal("Notification", ThrowingNotification as unknown as typeof FakeNotification);
    (ThrowingNotification as unknown as typeof FakeNotification).permission = "granted";

    expect(() => sendNotification("title")).not.toThrow();
  });
});

describe("notifyDeployResult", () => {
  let instances: FakeNotification[];

  beforeEach(() => {
    instances = [];
    class RecordingNotification extends FakeNotification {
      constructor(title: string, options?: { body?: string; tag?: string; icon?: string }) {
        super(title, options);
        instances.push(this);
      }
    }
    RecordingNotification.permission = "granted";
    vi.stubGlobal("Notification", RecordingNotification);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a success notification with app name and status in the body", () => {
    notifyDeployResult("my-app", "success");

    expect(instances[0]).toMatchObject({
      title: "Deploy successful",
      body: "my-app — success",
      tag: "deploy-my-app",
    });
  });

  it("sends a failure notification for a non-success status", () => {
    notifyDeployResult("my-app", "failed");

    expect(instances[0]).toMatchObject({
      title: "Deploy failed",
      body: "my-app — failed",
      tag: "deploy-my-app",
    });
  });
});
