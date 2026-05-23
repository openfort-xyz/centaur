from __future__ import annotations

from typing import Any

import httpx

from centaur_sdk import secret

_STRIPE_API_BASE = "https://api.stripe.com/v1"


class StripeClient:
    """Stripe REST API client for billing, subscriptions, and customer data.

    API reference: https://docs.stripe.com/api
    Auth: ``STRIPE_RESTRICTED_KEY`` (prefers ``rk_*`` prefix for read-only access).

    All methods are read-only when using a restricted key.
    """

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or secret("STRIPE_RESTRICTED_KEY", "")
        if not self.api_key:
            raise RuntimeError(
                "STRIPE_RESTRICTED_KEY not set. Set it in your .env file "
                "or inject it via the Centaur secrets system."
            )
        # Send the key as a raw Bearer token (Stripe accepts this) rather than
        # httpx.BasicAuth: BasicAuth base64-encodes the value, which would hide
        # the iron-proxy placeholder so the firewall could never swap in the
        # real credential. A raw header keeps the placeholder verbatim.
        self._http = httpx.Client(
            base_url=_STRIPE_API_BASE,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout=30.0,
        )

    # ── Customers ─────────────────────────────────────────────────────────

    def list_customers(
        self,
        *,
        email: str | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        """List customers.

        API: ``GET /v1/customers``
        """
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if email:
            params["email"] = email
        r = self._http.get("/customers", params=params)
        r.raise_for_status()
        return r.json()

    def get_customer(self, customer_id: str) -> dict[str, Any]:
        """Get a customer by ID.

        API: ``GET /v1/customers/{id}``
        """
        r = self._http.get(f"/customers/{customer_id}")
        r.raise_for_status()
        return r.json()

    # ── Subscriptions ─────────────────────────────────────────────────────

    def list_subscriptions(
        self,
        *,
        customer_id: str | None = None,
        status: str | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        """List subscriptions.

        API: ``GET /v1/subscriptions``
        """
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if customer_id:
            params["customer"] = customer_id
        if status:
            params["status"] = status
        r = self._http.get("/subscriptions", params=params)
        r.raise_for_status()
        return r.json()

    def get_subscription(self, subscription_id: str) -> dict[str, Any]:
        """Get a subscription by ID.

        API: ``GET /v1/subscriptions/{id}``
        """
        r = self._http.get(f"/subscriptions/{subscription_id}")
        r.raise_for_status()
        return r.json()

    # ── Invoices ──────────────────────────────────────────────────────────

    def list_invoices(
        self,
        *,
        customer_id: str | None = None,
        status: str | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        """List invoices.

        API: ``GET /v1/invoices``
        """
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if customer_id:
            params["customer"] = customer_id
        if status:
            params["status"] = status
        r = self._http.get("/invoices", params=params)
        r.raise_for_status()
        return r.json()

    def get_invoice(self, invoice_id: str) -> dict[str, Any]:
        """Get an invoice by ID.

        API: ``GET /v1/invoices/{id}``
        """
        r = self._http.get(f"/invoices/{invoice_id}")
        r.raise_for_status()
        return r.json()

    # ── Charges ───────────────────────────────────────────────────────────

    def list_charges(
        self,
        *,
        customer_id: str | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        """List charges.

        API: ``GET /v1/charges``
        """
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if customer_id:
            params["customer"] = customer_id
        r = self._http.get("/charges", params=params)
        r.raise_for_status()
        return r.json()

    # ── Balance ───────────────────────────────────────────────────────────

    def get_balance(self) -> dict[str, Any]:
        """Get current balance.

        API: ``GET /v1/balance``
        """
        r = self._http.get("/balance")
        r.raise_for_status()
        return r.json()

    # ── Products & Prices ─────────────────────────────────────────────────

    def list_products(self, *, limit: int = 10) -> dict[str, Any]:
        """List products.

        API: ``GET /v1/products``
        """
        r = self._http.get("/products", params={"limit": min(limit, 100)})
        r.raise_for_status()
        return r.json()

    def list_prices(self, *, limit: int = 10) -> dict[str, Any]:
        """List prices.

        API: ``GET /v1/prices``
        """
        r = self._http.get("/prices", params={"limit": min(limit, 100)})
        r.raise_for_status()
        return r.json()

    # ── Payment Intents ───────────────────────────────────────────────────

    def list_payment_intents(
        self,
        *,
        customer_id: str | None = None,
        limit: int = 10,
    ) -> dict[str, Any]:
        """List payment intents.

        API: ``GET /v1/payment_intents``
        """
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if customer_id:
            params["customer"] = customer_id
        r = self._http.get("/payment_intents", params=params)
        r.raise_for_status()
        return r.json()


def _client() -> StripeClient:
    return StripeClient()
