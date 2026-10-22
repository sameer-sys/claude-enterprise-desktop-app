#!/usr/bin/env python3
"""
Check if a website is up and measure its response time.
"""

import sys
import time
import argparse
import requests

def check_site(url: str, timeout: float = 10.0) -> None:
    """Send a GET request and report status + elapsed time."""
    try:
        start = time.perf_counter()
        response = requests.get(url, timeout=timeout)
        elapsed_ms = (time.perf_counter() - start) * 1000

        if response.ok:
            print(f"✅ {url} is up (status {response.status_code})")
        else:
            print(f"⚠️ {url} responded with status {response.status_code}")

        print(f"⏱️ Response time: {elapsed_ms:.1f} ms")
    except requests.exceptions.RequestException as e:
        print(f"❌ {url} is down or unreachable:")
        print(f"   {e}")

def main() -> None:
    parser = argparse.ArgumentParser(description="Website uptime & latency checker")
    parser.add_argument("url", help="Target URL (include http:// or https://)")
    parser.add_argument("-t", "--timeout", type=float, default=10,
                        help="Request timeout in seconds (default: 10)")
    args = parser.parse_args()

    check_site(args.url, args.timeout)

if __name__ == "__main__":
    # Ensure the script runs with a proper URL when called without args
    if len(sys.argv) == 1:
        print("Usage: python check_site.py <URL> [-t TIMEOUT]")
        sys.exit(1)
    main()