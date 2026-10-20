//! Resolve one client address only through an explicitly trusted immediate proxy.
//! Environment loading belongs to executable startup, never this module or AppState::new.
use std::{collections::HashSet, net::IpAddr};

use axum::http::HeaderMap;

const MAX_PROXY_ADDRESSES: usize = 64;
const MAX_CONFIG_BYTES: usize = 4096;

#[derive(Clone, Debug, Default)]
pub struct TrustedClientIpPolicy {
    peers: HashSet<IpAddr>,
}

impl TrustedClientIpPolicy {
    /// Empty configuration trusts no proxy. Only comma-separated exact IP literals are accepted.
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        if value.len() > MAX_CONFIG_BYTES {
            return Err("Trusted proxy configuration exceeds 4096 bytes");
        }
        if value.trim().is_empty() {
            return Ok(Self::default());
        }
        let mut peers = HashSet::new();
        for (index, address) in value.split(',').enumerate() {
            if index >= MAX_PROXY_ADDRESSES {
                return Err("Trusted proxy configuration exceeds 64 addresses");
            }
            let address = address
                .trim()
                .parse::<IpAddr>()
                .map_err(|_| "Trusted proxies must be comma-separated exact IP addresses")?;
            peers.insert(normalize(address));
        }
        Ok(Self { peers })
    }

    /// A missing, repeated, invalid or multi-address XFF always falls back to the TCP peer.
    pub fn resolve(&self, peer: IpAddr, headers: &HeaderMap) -> IpAddr {
        let peer = normalize(peer);
        if !self.peers.contains(&peer) {
            return peer;
        }
        let mut values = headers.get_all("x-forwarded-for").iter();
        let Some(value) = values.next() else {
            return peer;
        };
        if values.next().is_some() {
            return peer;
        }
        value
            .to_str()
            .ok()
            .and_then(|value| value.trim().parse::<IpAddr>().ok())
            .map(normalize)
            .unwrap_or(peer)
    }
}

fn normalize(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(address)),
        address => address,
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use axum::http::HeaderValue;

    use super::*;
    use crate::AuthLimiter;

    fn ip(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    fn forwarded(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", value.parse().unwrap());
        headers
    }

    #[test]
    fn default_and_empty_configuration_never_trust_headers() {
        let peer = ip("192.0.2.10");
        for policy in [
            TrustedClientIpPolicy::default(),
            TrustedClientIpPolicy::parse("").unwrap(),
            TrustedClientIpPolicy::parse(" \t ").unwrap(),
        ] {
            assert_eq!(policy.resolve(peer, &forwarded("198.51.100.1")), peer);
        }
    }

    #[test]
    fn configuration_accepts_only_bounded_exact_ip_lists() {
        let policy =
            TrustedClientIpPolicy::parse(" 192.0.2.10, 2001:db8::10, ::ffff:192.0.2.10 ").unwrap();
        assert_eq!(policy.peers.len(), 2);
        for invalid in [
            "192.0.2.0/24",
            "0.0.0.0/0",
            "::/0",
            "gateway",
            "localhost",
            "192.0.2.10:8080",
            "[2001:db8::10]",
            "fe80::1%en0",
            ",192.0.2.10",
            "192.0.2.10,",
            "192.0.2.10,,2001:db8::10",
        ] {
            assert!(
                TrustedClientIpPolicy::parse(invalid).is_err(),
                "accepted {invalid}"
            );
        }
        assert!(TrustedClientIpPolicy::parse(&" ".repeat(MAX_CONFIG_BYTES + 1)).is_err());
        let addresses = ["192.0.2.10"; MAX_PROXY_ADDRESSES + 1].join(",");
        assert!(TrustedClientIpPolicy::parse(&addresses).is_err());
    }

    #[test]
    fn only_the_allowlisted_immediate_peer_can_supply_one_address() {
        let policy = TrustedClientIpPolicy::parse("192.0.2.10,2001:db8::10").unwrap();
        assert_eq!(
            policy.resolve(ip("192.0.2.10"), &forwarded("198.51.100.1")),
            ip("198.51.100.1")
        );
        assert_eq!(
            policy.resolve(ip("2001:db8::10"), &forwarded("2001:db8:1::1")),
            ip("2001:db8:1::1")
        );
        // A forged trusted address in the header cannot make an untrusted TCP peer trusted.
        assert_eq!(
            policy.resolve(ip("192.0.2.11"), &forwarded("192.0.2.10")),
            ip("192.0.2.11")
        );
        let mut headers = HeaderMap::new();
        headers.insert("forwarded", HeaderValue::from_static("for=198.51.100.1"));
        headers.insert("x-real-ip", HeaderValue::from_static("198.51.100.1"));
        assert_eq!(policy.resolve(ip("192.0.2.10"), &headers), ip("192.0.2.10"));
    }

    #[test]
    fn missing_repeated_invalid_and_multi_address_headers_fall_back() {
        let policy = TrustedClientIpPolicy::parse("192.0.2.10").unwrap();
        let peer = ip("192.0.2.10");
        assert_eq!(policy.resolve(peer, &HeaderMap::new()), peer);
        for invalid in [
            "",
            " ",
            "unknown",
            "gateway",
            "198.51.100.1, 198.51.100.2",
            "198.51.100.1,",
            "198.51.100.1 198.51.100.2",
            "198.51.100.1:443",
            "[2001:db8::1]",
            "for=198.51.100.1",
            "\"198.51.100.1\"",
            "198.51.100.1/32",
            "fe80::1%eth0",
        ] {
            assert_eq!(policy.resolve(peer, &forwarded(invalid)), peer, "{invalid}");
        }
        let mut repeated = forwarded("198.51.100.1");
        repeated.append("x-forwarded-for", HeaderValue::from_static("198.51.100.1"));
        assert_eq!(policy.resolve(peer, &repeated), peer);
        let mut non_ascii = HeaderMap::new();
        non_ascii.insert("x-forwarded-for", HeaderValue::from_bytes(&[0xff]).unwrap());
        assert_eq!(policy.resolve(peer, &non_ascii), peer);
    }

    #[test]
    fn ipv4_mapped_ipv6_cannot_split_trust_or_rate_limit_identity() {
        let policy = TrustedClientIpPolicy::parse("::ffff:192.0.2.10").unwrap();
        for peer in [ip("192.0.2.10"), ip("::ffff:192.0.2.10")] {
            for client in ["198.51.100.1", "::ffff:198.51.100.1"] {
                assert_eq!(policy.resolve(peer, &forwarded(client)), ip("198.51.100.1"));
            }
        }
        assert_eq!(
            policy.resolve(ip("::ffff:192.0.2.11"), &forwarded("198.51.100.1")),
            ip("192.0.2.11")
        );
        assert_eq!(
            policy.resolve(ip("::192.0.2.10"), &forwarded("198.51.100.1")),
            ip("::192.0.2.10")
        );
    }

    #[test]
    fn two_clients_behind_one_proxy_each_get_thirty_auth_attempts() {
        let policy = TrustedClientIpPolicy::parse("192.0.2.10").unwrap();
        let proxy = ip("192.0.2.10");
        let key = |client: &str| format!("ip:{}", policy.resolve(proxy, &forwarded(client)));
        let mut limiter = AuthLimiter::default();
        let now = Instant::now();
        for _ in 0..30 {
            assert!(limiter.check(key("198.51.100.1"), 30, now).is_ok());
        }
        assert_eq!(
            limiter
                .check(key("198.51.100.1"), 30, now)
                .unwrap_err()
                .code,
            "RATE_LIMITED"
        );
        for _ in 0..30 {
            assert!(limiter.check(key("198.51.100.2"), 30, now).is_ok());
        }
        assert_eq!(
            limiter
                .check(key("198.51.100.2"), 30, now)
                .unwrap_err()
                .code,
            "RATE_LIMITED"
        );
        assert!(
            limiter
                .check(key("198.51.100.1"), 30, now + Duration::from_secs(60))
                .is_ok()
        );
    }

    #[test]
    fn spoofed_and_invalid_headers_cannot_rotate_the_auth_bucket() {
        for policy in [
            TrustedClientIpPolicy::default(),
            TrustedClientIpPolicy::parse("192.0.2.10").unwrap(),
        ] {
            let peer = ip("192.0.2.11");
            let mut limiter = AuthLimiter::default();
            let now = Instant::now();
            for attempt in 0..31 {
                let headers = forwarded(&format!("198.51.100.{}", attempt + 1));
                let address = policy.resolve(peer, &headers);
                let result = limiter.check(format!("ip:{address}"), 30, now);
                assert_eq!(result.is_ok(), attempt < 30);
            }
        }
        let policy = TrustedClientIpPolicy::parse("192.0.2.10").unwrap();
        let peer = ip("192.0.2.10");
        let mut limiter = AuthLimiter::default();
        let now = Instant::now();
        for attempt in 0..31 {
            let headers = forwarded(&format!("198.51.100.{}, 192.0.2.10", attempt + 1));
            let address = policy.resolve(peer, &headers);
            let result = limiter.check(format!("ip:{address}"), 30, now);
            assert_eq!(result.is_ok(), attempt < 30);
        }
    }
}
