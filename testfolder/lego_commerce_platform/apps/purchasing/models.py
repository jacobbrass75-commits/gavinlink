import uuid
from decimal import Decimal

from django.db import models
from django.utils import timezone


class Purchase(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        RECEIVED = "received", "Received"
        CLOSED = "closed", "Closed"
        VOID = "void", "Void"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source_name = models.CharField(max_length=255)
    source_reference = models.CharField(max_length=128, blank=True)
    purchased_at = models.DateTimeField(default=timezone.now)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.DRAFT)
    currency = models.CharField(max_length=3, default="USD")
    merchandise_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    shipping_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    fees_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    notes = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-purchased_at", "-created_at"]
        indexes = [
            models.Index(fields=["source_name", "purchased_at"]),
            models.Index(fields=["status", "purchased_at"]),
        ]

    @property
    def landed_cost(self) -> Decimal:
        return self.merchandise_cost + self.shipping_cost + self.fees_cost

    def __str__(self) -> str:
        return f"{self.source_name} {self.source_reference}".strip()


class PurchaseLine(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    purchase = models.ForeignKey(
        Purchase,
        on_delete=models.CASCADE,
        related_name="lines",
    )
    item = models.ForeignKey(
        "catalog.CatalogItem",
        on_delete=models.PROTECT,
        related_name="purchase_lines",
    )
    quantity = models.PositiveIntegerField()
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    line_total_cost = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    notes = models.TextField(blank=True)
    metadata = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["purchase", "item"]),
            models.Index(fields=["item", "created_at"]),
        ]

    def save(self, *args, **kwargs):
        if not self.line_total_cost:
            self.line_total_cost = self.unit_cost * self.quantity
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f"{self.quantity} x {self.item_id}"

