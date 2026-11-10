/** Host names that only this machine can reach. `[::1]` is how a URL writes the IPv6 loopback. */
export const loopbackNames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
