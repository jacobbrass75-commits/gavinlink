from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from django.db.models import Q, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone

from .models import InventoryEvent, InventoryReservation


@dataclass(frozen=True)
class StockBalance:
    item_id: str | None
    lot_id: str | None
    on_hand: int
    reserved: int
    available: int
    as_of: datetime


def _balance_filter(*, item=None, lot=None, as_of=None) -> Q:
    if item is None and lot is None:
        raise ValueError("Provide either item or lot when calculating stock.")
    if item is not None and lot is not None and getattr(lot, "item_id", None) != item.pk:
        raise ValueError("Inventory lot does not belong to the provided item.")

    query = Q()
    if item is not None:
        query &= Q(item=item)
    if lot is not None:
        query &= Q(lot=lot)
    if as_of is not None:
        query &= Q(occurred_at__lte=as_of)
    return query


def calculate_stock_balance(*, item=None, lot=None, as_of=None) -> StockBalance:
    as_of = as_of or timezone.now()
    event_filter = _balance_filter(item=item, lot=lot, as_of=as_of)
    reservation_filter = Q(status=InventoryReservation.Status.ACTIVE)
    if item is not None:
        reservation_filter &= Q(item=item)
    if lot is not None:
        reservation_filter &= Q(lot=lot)
    reservation_filter &= Q(created_at__lte=as_of)
    reservation_filter &= (Q(expires_at__isnull=True) | Q(expires_at__gt=as_of))

    on_hand = InventoryEvent.objects.filter(event_filter).aggregate(
        total=Coalesce(Sum("quantity_delta"), 0)
    )["total"]
    reserved = InventoryReservation.objects.filter(reservation_filter).aggregate(
        total=Coalesce(Sum("reserved_quantity"), 0)
    )["total"]
    return StockBalance(
        item_id=str(getattr(item, "pk", None)),
        lot_id=str(getattr(lot, "pk", None)),
        on_hand=int(on_hand),
        reserved=int(reserved),
        available=int(on_hand) - int(reserved),
        as_of=as_of,
    )


def record_inventory_event(
    *,
    item,
    quantity_delta: int,
    event_type: str,
    lot=None,
    reservation=None,
    purchase_line=None,
    occurred_at=None,
    reference_type: str = "",
    reference_id: str = "",
    idempotency_key: str | None = None,
    notes: str = "",
    metadata: Optional[dict] = None,
):
    if quantity_delta == 0:
        raise ValueError("Inventory events must change quantity.")
    defaults = {
        "item": item,
        "lot": lot,
        "reservation": reservation,
        "purchase_line": purchase_line,
        "event_type": event_type,
        "quantity_delta": quantity_delta,
        "occurred_at": occurred_at or timezone.now(),
        "reference_type": reference_type,
        "reference_id": reference_id,
        "notes": notes,
        "metadata": metadata or {},
    }
    if idempotency_key:
        event, _ = InventoryEvent.objects.get_or_create(
            idempotency_key=idempotency_key,
            defaults=defaults,
        )
        return event
    return InventoryEvent.objects.create(idempotency_key=idempotency_key, **defaults)


def reserve_inventory(
    *,
    item,
    reserved_quantity: int,
    reservation_key: str,
    lot=None,
    source_type: str = "",
    source_reference: str = "",
    expires_at=None,
    notes: str = "",
    metadata: Optional[dict] = None,
):
    if reserved_quantity <= 0:
        raise ValueError("Reserved quantity must be positive.")
    existing = InventoryReservation.objects.filter(reservation_key=reservation_key).first()
    if existing is not None:
        return existing

    balance = calculate_stock_balance(item=item, lot=lot)
    if balance.available < reserved_quantity:
        raise ValueError(
            f"Insufficient available stock for {getattr(item, 'internal_sku', item)}."
        )
    return InventoryReservation.objects.create(
        item=item,
        lot=lot,
        reservation_key=reservation_key,
        reserved_quantity=reserved_quantity,
        source_type=source_type,
        source_reference=source_reference,
        expires_at=expires_at,
        notes=notes,
        metadata=metadata or {},
    )


def release_inventory_reservation(reservation: InventoryReservation, *, notes: str = ""):
    if reservation.status != InventoryReservation.Status.ACTIVE:
        return reservation
    reservation.status = InventoryReservation.Status.RELEASED
    reservation.released_at = timezone.now()
    if notes:
        reservation.notes = f"{reservation.notes}\n{notes}".strip()
    reservation.save(update_fields=["status", "released_at", "notes", "updated_at"])
    return reservation


def apply_manual_adjustment(
    *,
    item,
    quantity_delta: int,
    lot=None,
    reference_id: str = "",
    notes: str = "",
    metadata: Optional[dict] = None,
):
    return record_inventory_event(
        item=item,
        lot=lot,
        event_type=InventoryEvent.EventType.ADJUSTED,
        quantity_delta=quantity_delta,
        reference_type="manual_adjustment",
        reference_id=reference_id,
        notes=notes,
        metadata=metadata,
    )


def reconcile_inventory_count(
    *,
    item,
    counted_quantity: int,
    lot=None,
    reference_id: str = "",
    notes: str = "",
):
    balance = calculate_stock_balance(item=item, lot=lot)
    variance = counted_quantity - balance.on_hand
    if variance == 0:
        return None
    return record_inventory_event(
        item=item,
        lot=lot,
        event_type=InventoryEvent.EventType.COUNTED,
        quantity_delta=variance,
        reference_type="cycle_count",
        reference_id=reference_id,
        notes=notes or f"Reconciled counted quantity to {counted_quantity}.",
        metadata={"counted_quantity": counted_quantity, "previous_on_hand": balance.on_hand},
    )
