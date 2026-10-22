#!/usr/bin/env python3
import sys
import time
import argparse
import requests

def check_site(url: str, timeout: float = 5.0) -> None:
    """Ping a URL and report its status + response time."""
    start = time.perf_counter()
    try:
        resp = requests.get(url, timeout=timeout, allow_redirects=True)
        elapsed_ms = (time.perf_counter() - start) * 1000
        up = resp.status_code < 400          # 2xx or 3xx → up
        status = "UP" if up else "DOWN"
        print(f"{url} → {status} (status {resp.status_code}) – {elapsed_ms:.1f} ms")
    except requests.RequestException as e:
        elapsed_ms = (time.perf_counter() - start) * 1000
        print(f"{url} → DOWN (error: {e}) – {elapsed_ms:.1f} ms")

def main() -> None:
    parser = argparse.ArgumentParser(description="Check if a website is up and measure response time.")
    parser.add_argument("url", help="Target URL (e.g. https://example.com)")
    parser.add_argument("-t", "--timeout", type=float, default=5.0,
                        help="Request timeout in seconds (default: 5)")
    args = parser.parse_args()

    # Ensure the URL has a scheme; prepend https:// if missing
    url = args.url if args.url.startswith(("http://", "https://")) else f"https://{args.url}"
    check_site(url, timeout=args.timeout)

if __name__ == "__main__":
    main()